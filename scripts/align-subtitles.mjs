import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ensurePython, ensureUv, inspectPython, privateEnvironment, venvPython } from './bootstrap.mjs';
import { mediaPath } from './media-tools.mjs';
import { parseSrt, simplified } from '../deepseek/lib/srt.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'scripts', 'align-subtitles.py');
function inside(directory, filename) {
  const relative = path.relative(directory, filename);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Validate before model downloads, environment changes, or output creation. */
export function prepareAlignmentInput(options) {
  if (!options.video || !options.text || !options.output) throw new Error('Usage: node scripts/align-subtitles.mjs --video inputs/source.mp4 --text inputs/subtitles.txt --output work/aligned');
  const video = realpathSync(path.resolve(options.video));
  const textFile = realpathSync(path.resolve(options.text));
  if (!statSync(video).isFile() || !statSync(textFile).isFile()) throw new Error('Video and subtitle text must be files.');
  if (statSync(textFile).size > 1024 * 1024) throw new Error('Subtitle text must be at most 1 MiB.');
  const originalText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(textFile));
  if (!originalText.trim()) throw new Error('Subtitle text is empty.');
  const target = path.resolve(options.output);
  const parent = realpathSync(path.dirname(target));
  if (!inside(realpathSync(root), path.join(parent, path.basename(target)))) throw new Error('Subtitle output must be a new directory inside the production workspace.');
  if (existsSync(target)) throw new Error('Subtitle output already exists; existing subtitles and user files are never overwritten.');
  let cues;
  if (/\.srt$/i.test(textFile) || /\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(originalText)) cues = parseSrt(originalText);
  return { video, textFile, target: path.join(parent, path.basename(target)), originalText, cues };
}

function run(command, args, { env, timeout } = {}) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', windowsHide: true, ...(timeout ? { timeout } : {}) });
  if (result.error || result.status !== 0) throw new Error(`Subtitle alignment step failed (${path.basename(command)}): ${result.error?.message ?? `exit ${result.status ?? result.signal}`}. Read the preceding error; no artificial subtitle timing was generated.`);
}

async function alignmentPython() {
  const env = privateEnvironment(root);
  if (existsSync(path.join(root, '.runtime')) && !inside(realpathSync(root), realpathSync(path.join(root, '.runtime')))) throw new Error('The runtime cache must remain inside this workspace.');
  if (existsSync(path.join(root, '.venv')) && lstatSync(path.join(root, '.venv')).isSymbolicLink()) throw new Error('The project .venv must not be a symlink to another Python environment.');
  let python = venvPython(root);
  const found = inspectPython(python, [], { env });
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (!found || normalize(found.prefix) !== normalize(path.join(root, '.venv'))) {
    const uv = await ensureUv(root, env);
    python = ensurePython(root, uv, env);
  }
  const recognitionProbe = "import importlib.metadata as m; import faster_whisper, ctranslate2, av; assert all(m.version(package) == version for package, version in [('faster-whisper', '1.2.1'), ('ctranslate2', '4.6.0'), ('av', '16.0.1'), ('setuptools', '80.9.0')]); assert 'int8' in ctranslate2.get_supported_compute_types('cpu')";
  const probe = spawnSync(python, ['-c', recognitionProbe], { env, windowsHide: true, encoding: 'utf8', timeout: 30000 });
  if (probe.status !== 0) {
    console.log('字幕对齐：首次准备本地 faster-whisper CPU 依赖，需要联网。');
    const uv = await ensureUv(root, env);
    python = ensurePython(root, uv, env);
    run(uv, ['pip', 'install', '--python', python, '-r', path.join(root, 'scripts', 'requirements-alignment.txt')], { env, timeout: 1800000 });
    const check = spawnSync(python, ['-c', recognitionProbe], { env, windowsHide: true, encoding: 'utf8', timeout: 30000 });
    if (check.status !== 0) throw new Error(`Local speech runtime could not load. Windows may need Microsoft Visual C++ 2015–2022 x64 Runtime; the fixed CTranslate2 wheel may be unavailable on this platform. ${check.stderr?.slice(-1800) ?? ''}`);
  }
  env.HF_HOME = path.join(root, '.runtime', 'whisper', 'huggingface');
  env.HF_HUB_DISABLE_TELEMETRY = '1';
  return { python, env };
}

/** Produce real audio-derived timing, or preserve an already timed SRT verbatim. */
export async function alignSubtitles(options) {
  const input = prepareAlignmentInput(options);
  const probe = spawnSync(mediaPath('ffprobe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', input.video], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (probe.error || probe.status !== 0) throw new Error('Cannot read the source video. Prepare FFmpeg with node scripts/bootstrap.mjs and check the input file.');
  const media = JSON.parse(probe.stdout);
  const duration = Number(media.format?.duration);
  if (!media.streams?.some(stream => stream.codec_type === 'video') || !Number.isFinite(duration) || duration <= 0) throw new Error('Input must contain a readable video stream with a finite duration.');
  if (input.cues && input.cues.at(-1).end > duration + .1) throw new Error('Provided SRT ends after the source video; correct its timestamps before production.');
  if (!input.cues && !media.streams.some(stream => stream.codec_type === 'audio')) throw new Error('The video has no audio track. Provide a correctly timed SRT; plain subtitle text cannot be aligned without speech audio.');
  mkdirSync(input.target);
  writeFileSync(path.join(input.target, 'source-text.txt'), input.originalText, { flag: 'wx' });
  if (input.cues) {
    writeFileSync(path.join(input.target, 'source.srt'), input.originalText, { flag: 'wx' });
    writeFileSync(path.join(input.target, 'alignment.json'), JSON.stringify({ status: 'provided-srt', duration, cues: input.cues.length, originalTextPreserved: true, timingSource: 'user-provided-srt', requiresReview: true }, null, 2) + '\n', { flag: 'wx' });
    console.log(`已保留输入 SRT，不下载识别模型：${path.join(input.target, 'source.srt')}`);
    return path.join(input.target, 'source.srt');
  }
  console.log('字幕对齐：检查本地 CPU 识别环境；不会上传原视频或生成配音。');
  const { python, env } = await alignmentPython();
  const recognition = path.join(input.target, 'recognition.json');
  console.log('字幕对齐：使用官方 small 模型识别真实词级时间；首次下载缓存在 .runtime/whisper。');
  run(python, [script, '--video', input.video, '--recognition-output', recognition, '--cache', path.join(root, '.runtime', 'whisper')], { env });
  const recognized = JSON.parse(readFileSync(recognition, 'utf8'));
  const reference = [];
  for (const [index, character] of [...input.originalText].entries()) {
    for (const atom of simplified(character).normalize('NFKC').toLowerCase()) if (/[\p{L}\p{N}]/u.test(atom)) reference.push({ index, char: atom });
  }
  const alignInput = path.join(input.target, 'alignment-input.json');
  writeFileSync(alignInput, JSON.stringify({ originalText: input.originalText, reference, duration, words: recognized.words.map(word => ({ ...word, normalized: simplified(word.word).normalize('NFKC').toLowerCase() })) }, null, 2), { flag: 'wx' });
  console.log('字幕对齐：逐字符匹配用户原文与识别词，检查覆盖率及真实时间锚点。');
  run(python, [script, '--align-input', alignInput, '--output', input.target], { env });
  console.log(`字幕已生成，须校对时间与识别偏差：${path.join(input.target, 'source.srt')}`);
  return path.join(input.target, 'source.srt');
}

export async function alignmentCli(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, strict: true, options: { video: { type: 'string' }, text: { type: 'string' }, output: { type: 'string' } } });
  return alignSubtitles(values);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  alignmentCli().catch(error => { console.error(`字幕对齐未完成：${error.message}`); process.exitCode = 1; });
}
