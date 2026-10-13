#!/usr/bin/env python3
"""CPU recognition and conservative supplied-text alignment; no fabricated timings."""
import argparse
from difflib import SequenceMatcher
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import unicodedata

ROOT = Path(__file__).resolve().parent.parent


def normalized(value):
    return ''.join(char for char in unicodedata.normalize('NFKC', value).lower() if char.isalnum())


def workspace_path(value):
    candidate = Path(value).resolve()
    if candidate == ROOT or not candidate.is_relative_to(ROOT):
        raise ValueError('Subtitle outputs and cache must remain inside the production workspace.')
    return candidate


def save_json(filename, value):
    with filename.open('x', encoding='utf-8') as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write('\n')


def recognize(video, output, cache):
    from faster_whisper import WhisperModel
    output = workspace_path(output)
    cache = workspace_path(cache)
    cache.mkdir(parents=True, exist_ok=True)
    print('识别原音频：small / CPU / int8；首次需要访问官方 Hugging Face 模型。', flush=True)
    model = WhisperModel('small', device='cpu', compute_type='int8', download_root=str(cache))
    segments, info = model.transcribe(str(video), language='zh', beam_size=5, word_timestamps=True,
                                     vad_filter=True, condition_on_previous_text=False)
    words = []
    for segment in segments:
        for word in segment.words or []:
            if word.end > word.start and normalized(word.word):
                words.append({'word': word.word, 'start': word.start, 'end': word.end,
                              'probability': word.probability})
        print(f'已识别至 {segment.end:.1f} 秒。', flush=True)
    save_json(output, {'model': 'small', 'device': 'cpu', 'computeType': 'int8',
                       'duration': info.duration, 'language': info.language,
                       'words': words, 'timingSource': 'faster-whisper-word-timestamps'})


def caption_spans(text, maximum=24):
    """Keep supplied text and punctuation; only introduce readable cue boundaries."""
    result = []
    start, count, last_break = 0, 0, 0
    for index, char in enumerate(text):
        count += int(char.isalnum())
        if char in '，,、：:':
            last_break = index + 1
        if char in '\r\n。！？!?；;':
            end = index + 1
        elif count > maximum:
            # Prefer a clause boundary; wait for the next letter so trailing punctuation stays attached.
            end = last_break if last_break > start else index
        else:
            continue
        if text[start:end].strip():
            result.append((start, end))
        start = end
        count = sum(char.isalnum() for char in text[start:index + 1])
        last_break = 0
    if text[start:].strip():
        result.append((start, len(text)))
    return result


def timestamp(seconds):
    value = round(seconds * 1000)
    hours, remainder = divmod(value, 3600000)
    minutes, remainder = divmod(remainder, 60000)
    secs, millis = divmod(remainder, 1000)
    return f'{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}'


def align(data):
    """Every cue endpoint comes from a recognized word; characters are never evenly timed."""
    text, duration = data['originalText'], float(data['duration'])
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError('Invalid source duration.')
    reference = data.get('reference')
    if reference is None:
        reference = [{'index': index, 'char': atom} for index, char in enumerate(text)
                     for atom in normalized(char)]
    tokens = []
    previous_start = -1
    for word_index, word in enumerate(data['words']):
        start, end = float(word['start']), float(word['end'])
        if not all(math.isfinite(value) for value in [start, end]) or start < 0 or end <= start or end > duration + .1 or start < previous_start:
            raise ValueError('Invalid or unordered recognized word timestamps.')
        previous_start = start
        for char in normalized(word.get('normalized', word['word'])):
            tokens.append({'char': char, 'start': start, 'end': min(end, duration), 'word': word_index})
    target = ''.join(atom['char'] for atom in reference)
    recognized = ''.join(atom['char'] for atom in tokens)
    matcher = SequenceMatcher(None, target, recognized, autojunk=False)
    mapping = {a + offset: b + offset for a, b, length in matcher.get_matching_blocks()
               for offset in range(length)}
    coverage = len(mapping) / len(target) if target else 0
    precision = len(mapping) / len(recognized) if recognized else 0
    changes = [{'kind': kind, 'supplied': target[a:b], 'recognized': recognized[c:d]}
               for kind, a, b, c, d in matcher.get_opcodes() if kind != 'equal']
    report = {'status': 'alignment-rejected', 'timingSource': 'faster-whisper-word-timestamps',
              'originalTextPreserved': True, 'matchCoverage': coverage,
              'recognitionCoverage': precision, 'matchedCharacters': len(mapping),
              'suppliedCharacters': len(target), 'recognizedCharacters': len(recognized),
              'differences': changes, 'requiresReview': True, 'cues': []}
    reasons = []
    if not target or not recognized:
        reasons.append('No usable supplied text or recognized speech words.')
    if coverage < .90 or precision < .85:
        reasons.append('Text differs significantly from the recorded speech (required supplied coverage 90%, recognized coverage 85%).')
    if any(max(len(change['supplied']), len(change['recognized'])) > 3 for change in changes):
        reasons.append('An unmatched content span exceeds three characters; correct the transcript or provide timed SRT.')
    for beginning, ending in caption_spans(text):
        positions = [index for index, atom in enumerate(reference) if beginning <= atom['index'] < ending]
        if not positions:
            continue
        matched = [index for index in positions if index in mapping]
        if not matched or len(matched) / len(positions) < .85 or matched[0] - positions[0] > 1 or positions[-1] - matched[-1] > 1:
            reasons.append('A caption lacks sufficient matching speech or reliable beginning/end word anchors.')
            continue
        start = tokens[mapping[matched[0]]]['start']
        end = tokens[mapping[matched[-1]]]['end']
        caption = text[beginning:ending].strip()
        if report['cues'] and start < report['cues'][-1]['end']:
            # One actual spoken word may straddle a text cue boundary. Merge instead of inventing a cut time.
            previous = report['cues'][-1]
            previous['text'] += caption
            previous['end'] = max(previous['end'], end)
            previous['matchedCharacters'] += len(matched)
        else:
            report['cues'].append({'start': start, 'end': end, 'text': caption,
                                   'matchedCharacters': len(matched)})
    if not report['cues']:
        reasons.append('No reliable subtitle cues could be aligned.')
    report['rejectionReasons'] = list(dict.fromkeys(reasons))
    if not reasons:
        report['status'] = 'aligned-awaiting-timing-review'
    return report


def write_alignment(source, output):
    output = workspace_path(output)
    data = json.loads(Path(source).read_text(encoding='utf-8-sig'))
    report = align(data)
    save_json(output / 'alignment.json', report)
    if report['status'] == 'alignment-rejected':
        raise ValueError(' '.join(report['rejectionReasons']) + f' Review {output / "alignment.json"}; no SRT was produced.')
    descriptor, temporary = tempfile.mkstemp(prefix='.source-srt-', suffix='.tmp', dir=output)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as handle:
            for index, cue in enumerate(report['cues'], 1):
                handle.write(f'{index}\n{timestamp(cue["start"])} --> {timestamp(cue["end"])}\n{cue["text"]}\n\n')
            handle.flush()
            os.fsync(handle.fileno())
        # Hard-link publication is atomic and exclusive on POSIX and Windows NTFS.
        # Unlike replace/rename, it never overwrites an existing user subtitle file.
        os.link(temporary, output / 'source.srt')
    finally:
        os.unlink(temporary)
    print(f'对齐覆盖率 {report["matchCoverage"]:.1%}，生成 {len(report["cues"])} 条字幕；时间来自原音频词级识别，仍需校对。', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--video')
    parser.add_argument('--recognition-output')
    parser.add_argument('--cache')
    parser.add_argument('--align-input')
    parser.add_argument('--output')
    args = parser.parse_args()
    if args.align_input and args.output:
        write_alignment(args.align_input, args.output)
    elif args.video and args.recognition_output and args.cache:
        recognize(args.video, args.recognition_output, args.cache)
    else:
        parser.error('Specify video/recognition-output/cache OR align-input/output.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'字幕对齐失败：{error}', file=sys.stderr, flush=True)
        sys.exit(1)
