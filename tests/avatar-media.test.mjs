import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareAvatar } from '../scripts/prepare-avatar.mjs';
import { mediaPath } from '../scripts/media-tools.mjs';

test('digital human preparation replaces original audio and rejects short video and overwrites', t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const work = path.join(root, 'work'); mkdirSync(work, { recursive: true });
  const directory = realpathSync(mkdtempSync(path.join(work, 'avatar-media-test-')));
  t.after(() => { assert.equal(path.dirname(realpathSync(directory)), realpathSync(work)); rmSync(directory, { recursive: true }); });
  const video = path.join(directory, 'avatar.mp4'), audio = path.join(directory, 'voice.wav'), longVoice = path.join(directory, 'long.wav');
  const roundedVoice = path.join(directory, 'rounded.wav'), shortVoice = path.join(directory, 'short.wav');
  function ffmpeg(args) {
    const result = spawnSync(mediaPath('ffmpeg'), ['-v', 'error', '-nostdin', '-n', ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
  }
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=2:r=25', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', video]);
  for (const [file, duration] of [[audio, 1], [longVoice, 3], [roundedVoice, 2.01], [shortVoice, 2.1]]) ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=800:sample_rate=24000:duration=${duration}`, '-c:a', 'pcm_s16le', file]);
  const output = path.join(directory, 'voiced-avatar.mp4');
  assert.equal(prepareAvatar({ video, audio, output }), output);
  const decoded = path.join(directory, 'decoded.raw');
  ffmpeg(['-i', output, '-map', '0:a:0', '-ar', '24000', '-ac', '1', '-f', 's16le', decoded]);
  const bytes = readFileSync(decoded);
  let crossings = 0;
  for (let i = 2; i < Math.min(bytes.length, 24000); i += 2) if (bytes.readInt16LE(i - 2) < 0 && bytes.readInt16LE(i) >= 0) crossings++;
  assert.ok(crossings > 370 && crossings < 430, `expected new 800Hz narration, observed ${crossings * 2}Hz`);
  assert.throws(() => prepareAvatar({ video, audio, output }), /new MP4/);
  assert.throws(() => prepareAvatar({ video, audio: longVoice, output: path.join(directory, 'short.mp4') }), /complete generated narration/);
  assert.throws(() => prepareAvatar({ video, audio: shortVoice, output: path.join(directory, 'too-short.mp4') }), /complete generated narration/);
  const roundedOutput = path.join(directory, 'rounded-avatar.mp4');
  prepareAvatar({ video, audio: roundedVoice, output: roundedOutput });
  const metadata = spawnSync(mediaPath('ffprobe'), ['-v', 'error', '-show_streams', '-of', 'json', roundedOutput], { encoding: 'utf8', windowsHide: true });
  assert.equal(metadata.status, 0, metadata.stderr);
  const { streams } = JSON.parse(metadata.stdout);
  assert.ok(Math.abs(Number(streams.find(stream => stream.codec_type === 'audio').duration) - 2.01) <= .002, 'the complete narration must survive frame rounding');
  assert.ok(Number(streams.find(stream => stream.codec_type === 'video').duration) >= 2.01, 'hold the final frame to cover the narration');
  ffmpeg(['-i', roundedOutput, '-f', 'null', '-']);
  const maskedVideo = path.join(directory, 'masked-short.mp4');
  ffmpeg(['-i', video, '-i', longVoice, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', maskedVideo]);
  assert.throws(() => prepareAvatar({ video: maskedVideo, audio: longVoice, output: path.join(directory, 'masked-output.mp4') }), /complete generated narration/);
});
