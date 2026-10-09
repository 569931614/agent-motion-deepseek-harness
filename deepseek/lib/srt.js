import { Converter } from 'opencc-js/t2cn';
const convert = Converter({ from: 'tw', to: 'cn' });
/** Normalize visible text to Simplified Chinese without changing subtitle timing. */
export function simplified(text) {
    return convert(text.normalize('NFC'));
}
function seconds(value) {
    const match = /^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})$/.exec(value);
    if (!match)
        throw new Error(`Invalid SRT timestamp: ${value}`);
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}
/** Parse UTF-8 SRT, rejecting ambiguous overlapping cues and malformed timings. */
export function parseSrt(source) {
    const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
    if (!text)
        throw new Error('SRT is empty.');
    const cues = text.split(/\n[\t ]*\n+/).map((block, position) => {
        const lines = block.split('\n');
        if (/^\d+$/.test(lines[0] ?? ''))
            lines.shift();
        const timing = /^(\S+)\s+-->\s+(\S+)\s*$/.exec(lines.shift() ?? '');
        if (!timing)
            throw new Error(`SRT cue ${position + 1}: expected start --> end.`);
        const start = seconds(timing[1]);
        const end = seconds(timing[2]);
        const content = simplified(lines.join('\n').replace(/<[^>]*>/g, '').trim());
        if (end <= start || !content)
            throw new Error(`SRT cue ${position + 1}: empty text or invalid duration.`);
        if (/[A-Za-z]/.test(content) && !/\p{Script=Han}/u.test(content)) {
            throw new Error(`SRT cue ${position + 1}: translate into Chinese with the Harness model before production.`);
        }
        return { index: position + 1, start, end, text: content };
    });
    for (let i = 1; i < cues.length; i++) {
        if (cues[i].start < cues[i - 1].end)
            throw new Error(`SRT cue ${i + 1}: cues overlap or are out of order.`);
    }
    return cues;
}
