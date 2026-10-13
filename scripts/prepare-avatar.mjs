import { existsSync, linkSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { mediaPath } from './media-tools.mjs';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
function inside(file) {
  const relative = path.relative(root, file);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function run(name, args) {
  const result = spawnSync(mediaPath(name), args, { windowsHide: true, encoding: 'utf8', timeout: 600000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${name} failed: ${result.error?.message ?? result.stderr?.slice(-1200) ?? result.status}`);
  return result.stdout;
}
function probe(file) {
  return JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
}

/** Replace all avatar audio with the generated voice before subtitle alignment and production. */
export function prepareAvatar({ video, audio, output }) {
  if (!video || !audio || !output) throw new Error('Provide --video, --audio and --output.');
  const videoPath = realpathSync(path.resolve(video)), audioPath = realpathSync(path.resolve(audio));
  const destination = path.resolve(output);
  const target = path.join(realpathSync(path.dirname(destination)), path.basename(destination));
  if (![videoPath, audioPath, target].every(inside) || !statSync(videoPath).isFile() || !statSync(audioPath).isFile()) throw new Error('Avatar, voice and output must be inside the production workspace.');
  if (existsSync(target) || path.extname(target).toLowerCase() !== '.mp4') throw new Error('Output must be a new MP4 file.');
  const movie = probe(videoPath), voice = probe(audioPath);
  const videoStream = movie.streams?.find(stream => stream.codec_type === 'video');
  const duration = Number(voice.format?.duration), videoDuration = Number(videoStream?.duration);
  const [numerator, denominator = 1] = String(videoStream?.avg_frame_rate || videoStream?.r_frame_rate).split('/').map(Number);
  const fps = numerator / denominator;
  if (!voice.streams?.some(stream => stream.codec_type === 'audio') || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(videoDuration) || videoDuration <= 0 || !Number.isFinite(fps) || fps <= 0 || videoDuration + 1 / fps + .001 < duration) throw new Error('The digital human video must cover the complete generated narration.');
  const videoEncoding = videoDuration < duration
    ? ['-vf', 'tpad=stop_mode=clone:stop=1', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p']
    : ['-c:v', 'copy'];
  const pending = path.join(path.dirname(target), `avatar-${randomUUID()}.pending.mp4`);
  try {
    run('ffmpeg', ['-nostdin', '-v', 'error', '-n', '-i', videoPath, '-i', audioPath, '-map', '0:v:0', '-map', '1:a:0', ...videoEncoding, '-c:a', 'aac', '-t', String(duration), '-movflags', '+faststart', pending]);
    const merged = probe(pending);
    const mergedAudioDuration = Number(merged.streams?.find(stream => stream.codec_type === 'audio')?.duration);
    const mergedVideoDuration = Number(merged.streams?.find(stream => stream.codec_type === 'video')?.duration);
    if (!Number.isFinite(mergedAudioDuration) || Math.abs(mergedAudioDuration - duration) > .002 || !Number.isFinite(mergedVideoDuration) || mergedVideoDuration + .001 < duration) throw new Error('Generated voice/video duration verification failed.');
    linkSync(pending, target); // Exclusive publication; never replace an existing user file.
  } finally { if (existsSync(pending)) unlinkSync(pending); }
  return target;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { video: { type: 'string' }, audio: { type: 'string' }, output: { type: 'string' } } });
    console.log(prepareAvatar(values));
  } catch (error) { console.error(`数字人配音合并未完成：${error.message}`); process.exitCode = 1; }
}
