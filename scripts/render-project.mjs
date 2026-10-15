import { spawnSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../serve.mjs';
import { launchBrowser } from './browser.mjs';
import { mediaPath } from './media-tools.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} failed: ${result.error?.message ?? result.stderr?.slice(-4000)}`);
  return result.stdout;
}
function probe(video) { return JSON.parse(run(mediaPath('ffprobe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video])); }
function inside(directory, file) {
  const relative = path.relative(directory, file);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
function json(file, value) { writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
export function validateEncoding(width, height, fps) {
  if (![width, height].every(value => Number.isInteger(value) && value >= 128 && value <= 4096 && value % 2 === 0) || !Number.isInteger(fps) || fps < 1 || fps > 60) throw new Error('Use even dimensions 128–4096 and an integer frame rate 1–60.');
}
export function validateMusicVolume(volume) {
  if (!Number.isFinite(volume) || volume < 0 || volume > .3) throw new Error('Music volume must be between 0 and 0.3 to protect the speech track.');
}
function imageExtension(data) {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'jpg';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'webp';
  throw new Error('Expected PNG, JPEG or WebP image bytes.');
}

/** Render an editable project at absolute times and mux its original speech audio. */
export async function renderProject(directory) {
  const target = realpathSync(directory);
  if (!inside(realpathSync(root), target)) throw new Error('Render project must be inside the production workspace.');
  const film = JSON.parse(readFileSync(path.join(target, 'film.json'), 'utf8'));
  validateEncoding(film.width, film.height, film.fps);
  if (!Number.isFinite(film.duration) || film.duration <= 0) throw new Error('Invalid film duration.');
  if (film.music) validateMusicVolume(film.music.volume);
  if (film.backgroundImage !== undefined) {
    if (typeof film.backgroundImage !== 'string' || !/^background\.(?:png|jpg|webp)$/.test(film.backgroundImage) || !inside(target, realpathSync(path.join(target, film.backgroundImage)))) throw new Error('Background image must be a local PNG, JPEG or WebP inside the film directory.');
    imageExtension(readFileSync(path.join(target, film.backgroundImage)));
  }
  const output = path.join(target, 'final.mp4');
  if (existsSync(output)) throw new Error('final.mp4 already exists. Rename it before re-rendering; no finished output is overwritten.');
  const frames = path.join(target, 'frames');
  mkdirSync(frames, { recursive: true });
  const service = await startServer({ port: 0, root });
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: film.width, height: film.height }, deviceScaleFactor: 1 });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });
    const route = path.relative(root, target).split(path.sep).map(encodeURIComponent).join('/');
    await page.goto(`${service.url}/${route}/index.html?capture=1`);
    await page.waitForFunction(() => 'film' in window, null, { timeout: 30000 });
    const count = Math.ceil(film.duration * film.fps);
    for (let frame = 0; frame < count; frame++) {
      await page.evaluate(async time => {
        await window.film.renderAt(time);
      }, frame / film.fps);
      await page.screenshot({ path: path.join(frames, `frame-${String(frame).padStart(6, '0')}.png`) });
      if (frame % film.fps === 0) console.log(`渲染 ${frame}/${count} 帧`);
    }
    if (pageErrors.length) throw new Error(pageErrors.join('\n'));
    const inputs = ['-framerate', String(film.fps), '-i', path.join(frames, 'frame-%06d.png'), '-i', path.join(target, 'source.mp4')];
    const map = ['-map', '0:v:0'];
    if (film.music) {
      inputs.push('-stream_loop', '-1', '-i', path.join(target, 'music.audio'));
      const bed = `[2:a]volume=${film.music.volume},aresample=async=1:first_pts=0[bed]`;
      map.push('-filter_complex', film.hasAudio ? `[1:a]aresample=async=1:first_pts=0,apad[speech];${bed};[speech][bed]amix=inputs=2:duration=longest:normalize=0[mix]` : `${bed};[bed]anull[mix]`, '-map', '[mix]', '-c:a', 'aac', '-b:a', '192k');
    } else map.push(...(film.hasAudio ? ['-map', '1:a:0', '-af', 'aresample=async=1:first_pts=0,apad', '-c:a', 'aac', '-b:a', '192k'] : ['-an']));
    const pending = path.join(target, 'final.pending.mp4');
    run(mediaPath('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', ...inputs, ...map, '-t', String(film.duration), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', pending]);
    const metadata = probe(pending);
    if (!metadata.streams.some(stream => stream.codec_name === 'h264') || (film.hasAudio && !metadata.streams.some(stream => stream.codec_type === 'audio')) || Math.abs(Number(metadata.format.duration) - film.duration) > 1 / film.fps + 0.05) throw new Error('Output codec, audio or duration validation failed.');
    copyFileSync(pending, output, constants.COPYFILE_EXCL);
    unlinkSync(pending);
    json(path.join(target, 'validation.json'), { video: metadata, fps: film.fps, frames: count, style: film.style?.name, subtitleLanguage: 'zh-CN', originalSpeechAudio: film.hasAudio, status: 'rendered-awaiting-audiovisual-review', scope: '编码、字幕时序和音轨检查通过；人物边缘、完整连续动作及声音仍需实际复查。' });
    console.log(`输出：${output}\n预览与可编辑工程：${path.join(target, 'index.html')}`);
  } finally {
    await browser?.close();
    await new Promise(resolve => service.server.close(() => resolve()));
  }
}
