import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareAlignmentInput, alignSubtitles } from '../scripts/align-subtitles.mjs';
import { findPython } from '../scripts/runtime.mjs';
import { mediaPath } from '../scripts/media-tools.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pythonScript = path.join(root, 'scripts', 'align-subtitles.py');
function temporary(t) {
  const work = path.join(root, 'work');
  mkdirSync(work, { recursive: true });
  const canonicalWork = realpathSync(work);
  const directory = realpathSync(mkdtempSync(path.join(canonicalWork, 'subtitles-test-')));
  t.after(() => {
    const canonical = realpathSync(directory);
    assert.equal(canonical, directory);
    assert.equal(path.dirname(canonical), canonicalWork);
    assert.ok(path.basename(canonical).startsWith('subtitles-test-'));
    rmSync(canonical, { recursive: true, force: false });
  });
  return directory;
}
function fixtureAlignment(directory, fixture) {
  const source = path.join(directory, 'alignment-fixture.json');
  writeFileSync(source, JSON.stringify(fixture), { flag: 'wx' });
  const { command, prefix } = findPython();
  const result = spawnSync(command, [...prefix, pythonScript, '--align-input', source, '--output', directory], { encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' }, timeout: 30000 });
  return { result, report: JSON.parse(readFileSync(path.join(directory, 'alignment.json'), 'utf8')), srt: path.join(directory, 'source.srt') };
}

test('supplied words keep their original text and use exact recognized anchors across silence and repeated phrases', t => {
  const directory = temporary(t);
  const originalText = '你好，世界。\n我们一起学！我们一起学！';
  const words = [
    { word: '你好', start: .22, end: .58 }, { word: '世界', start: .83, end: 1.29 },
    { word: '我们', start: 4.73, end: 5.02 }, { word: '一起', start: 5.1, end: 5.49 }, { word: '学', start: 5.5, end: 5.77 },
    { word: '我们', start: 7.04, end: 7.37 }, { word: '一起', start: 7.52, end: 7.83 }, { word: '学', start: 7.88, end: 8.23 },
  ];
  const { result, report, srt } = fixtureAlignment(directory, { originalText, duration: 10, words });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.matchCoverage, 1);
  assert.equal(report.recognitionCoverage, 1);
  assert.equal(report.status, 'aligned-awaiting-timing-review');
  assert.deepEqual(report.cues.map(cue => [cue.start, cue.end, cue.text]), [[.22, 1.29, '你好，世界。'], [4.73, 5.77, '我们一起学！'], [7.04, 8.23, '我们一起学！']]);
  const text = readFileSync(srt, 'utf8');
  assert.match(text, /00:00:00,220 --> 00:00:01,290/);
  assert.match(text, /00:00:04,730 --> 00:00:05,770/);
  assert.ok(!text.includes('00:00:03,333'));
});

test('large content mismatch and a missing caption anchor leave a rejection report and never create fabricated SRT', t => {
  for (const [name, fixture] of [
    ['unrelated', { originalText: '用户提供的是关于太阳能的字幕。', duration: 5, words: [{ word: '今天介绍完全不同的商业活动', start: .1, end: 4.2 }] }],
    ['missing-anchor', { originalText: '太阳能让绿色能源持续改变我们的未来。', duration: 6, words: [{ word: '让绿色能源持续改变我们的未来', start: 1.2, end: 5.7 }] }],
    ['no-speech', { originalText: '这段原文不能按时间均分。', duration: 3, words: [] }],
  ]) {
    const directory = temporary(t);
    const { result, report, srt } = fixtureAlignment(directory, fixture);
    assert.notEqual(result.status, 0, name);
    assert.equal(report.status, 'alignment-rejected');
    assert.ok(report.rejectionReasons.length > 0);
    assert.ok(!existsSync(srt));
    assert.match(result.stderr, /no SRT was produced/);
  }
});

test('long captions prefer clause punctuation and keep punctuation at the character limit with real word anchors', t => {
  const originalText = '系统自动对齐字幕，完成人像抠图与动效合成，最后输出可播放的视频。';
  const words = [
    { word: '系统自动对齐字幕', start: 4.78, end: 6.2 },
    { word: '完成人像抠图与动效合成', start: 6.2, end: 8.04 },
    { word: '最后输出可', start: 8.04, end: 8.86 },
    { word: '播放的视频', start: 8.86, end: 9.56 },
  ];
  const { result, report } = fixtureAlignment(temporary(t), { originalText, duration: 10, words });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(report.cues.map(cue => [cue.start, cue.end, cue.text]), [
    [4.78, 8.04, '系统自动对齐字幕，完成人像抠图与动效合成，'],
    [8.04, 9.56, '最后输出可播放的视频。'],
  ]);
  assert.equal(report.cues.map(cue => cue.text).join(''), originalText);

  const atLimit = '甲'.repeat(24) + '。';
  const preserved = fixtureAlignment(temporary(t), { originalText: atLimit, duration: 3, words: [{ word: '甲'.repeat(24), start: .4, end: 2.7 }] });
  assert.equal(preserved.result.status, 0, preserved.result.stderr);
  assert.deepEqual(preserved.report.cues.map(cue => [cue.start, cue.end, cue.text]), [[.4, 2.7, atLimit]]);
});

test('word boundaries preserve visible text and SRT publishes exclusively after the complete write', t => {
  const directory = temporary(t);
  const originalText = '學習。資訊！';
  const reference = [{ index: 0, char: '学' }, { index: 1, char: '习' }, { index: 3, char: '资' }, { index: 4, char: '讯' }];
  const { result, report, srt } = fixtureAlignment(directory, { originalText, reference, duration: 3, words: [{ word: '学习资讯', start: .6, end: 2.1 }] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(report.cues.map(cue => [cue.start, cue.end, cue.text]), [[.6, 2.1, originalText]]);
  assert.match(readFileSync(srt, 'utf8'), /學習。資訊！/);
  assert.ok(!readdirSync(directory).some(name => name.startsWith('.source-srt-')));

  const protectedDirectory = temporary(t);
  writeFileSync(path.join(protectedDirectory, 'source.srt'), 'existing user subtitle');
  const fixture = { originalText: '你好。', duration: 3, words: [{ word: '你好', start: .6, end: 2.1 }] };
  const protectedResult = fixtureAlignment(protectedDirectory, fixture);
  assert.notEqual(protectedResult.result.status, 0);
  assert.equal(readFileSync(protectedResult.srt, 'utf8'), 'existing user subtitle');
  assert.ok(existsSync(path.join(protectedDirectory, 'alignment.json')));
  assert.ok(!readdirSync(protectedDirectory).some(name => name.startsWith('.source-srt-')));

  const failedDirectory = temporary(t);
  const failedInput = path.join(failedDirectory, 'alignment-fixture.json');
  writeFileSync(failedInput, JSON.stringify({ originalText: '你好。你好。', duration: 3, words: [{ word: '你好', start: .2, end: .7 }, { word: '你好', start: 1.4, end: 2.1 }] }));
  const { command, prefix } = findPython();
  const failureScript = `import runpy,sys
module=runpy.run_path(sys.argv[1])
function=module['write_alignment']
original=module['timestamp']
calls=0
def fail_after_first_cue(value):
    global calls
    calls += 1
    if calls == 3: raise OSError('simulated write failure')
    return original(value)
function.__globals__['timestamp']=fail_after_first_cue
function(sys.argv[2],module['Path'](sys.argv[3]))`;
  const failed = spawnSync(command, [...prefix, '-c', failureScript, pythonScript, failedInput, failedDirectory], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /simulated write failure/);
  assert.ok(existsSync(path.join(failedDirectory, 'alignment.json')));
  assert.ok(!existsSync(path.join(failedDirectory, 'source.srt')));
  assert.ok(!readdirSync(failedDirectory).some(name => name.startsWith('.source-srt-')));
});

test('CLI validates directories before downloads and timed SRT passes through without the recognition runtime', async t => {
  const directory = temporary(t);
  const dummyVideo = path.join(directory, 'dummy.mp4');
  const plainText = path.join(directory, 'subtitles.txt');
  writeFileSync(dummyVideo, 'not a video');
  writeFileSync(plainText, '必须与原语音匹配。');
  assert.throws(() => prepareAlignmentInput({ video: dummyVideo, text: plainText, output: directory }), /already exists/);
  assert.throws(() => prepareAlignmentInput({ video: dummyVideo, text: plainText, output: path.join(path.dirname(root), 'must-not-create-subtitles') }), /inside the production workspace/);
  assert.throws(() => prepareAlignmentInput({ video: dummyVideo, text: plainText, output: path.join(directory, 'missing-parent', 'output') }), /ENOENT/);
  const badSrt = path.join(directory, 'bad.srt');
  writeFileSync(badSrt, '1\n00:00:02,000 --> 00:00:01,000\n坏时间。');
  assert.throws(() => prepareAlignmentInput({ video: dummyVideo, text: badSrt, output: path.join(directory, 'bad-output') }), /invalid duration/);
  const rejected = path.join(directory, 'bad-video-output');
  await assert.rejects(alignSubtitles({ video: dummyVideo, text: plainText, output: rejected }), /Cannot read/);
  assert.ok(!existsSync(rejected));

  const video = path.join(directory, 'synthetic.mp4');
  const encode = spawnSync(mediaPath('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=size=128x128:rate=4:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-n', video], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(encode.status, 0, encode.stderr);
  await assert.rejects(alignSubtitles({ video, text: plainText, output: path.join(directory, 'no-audio') }), /no audio track/);
  assert.ok(!existsSync(path.join(directory, 'no-audio')));
  const inputSrt = path.join(directory, 'original.srt');
  const original = '\uFEFF1\r\n00:00:00,250 --> 00:00:01,500\r\n原來的字幕，逐字保留。\r\n';
  writeFileSync(inputSrt, original);
  const output = path.join(directory, 'passthrough');
  const venvBefore = existsSync(path.join(root, '.venv'));
  const saved = await alignSubtitles({ video, text: inputSrt, output });
  assert.equal(readFileSync(saved, 'utf8'), original);
  assert.equal(JSON.parse(readFileSync(path.join(output, 'alignment.json'), 'utf8')).timingSource, 'user-provided-srt');
  assert.equal(existsSync(path.join(root, '.venv')), venvBefore);
  assert.ok(!existsSync(path.join(output, 'recognition.json')));
});
