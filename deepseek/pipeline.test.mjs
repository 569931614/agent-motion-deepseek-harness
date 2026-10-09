import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSrt, simplified } from './lib/srt.js';
import { selectTemplate } from './lib/templates.js';
import { renderProject } from './lib/produce.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

test('SRT preserves exact times, normalizes Chinese, and rejects invalid input', () => {
  const cues = parseSrt('\uFEFF1\r\n00:00:00,125 --> 00:00:01,250\r\n學習讓資訊更清晰。\r\n\r\n2\r\n00:00:01.250 --> 00:00:02.500\r\n<strong>再練習。</strong>');
  assert.deepEqual(cues, [{ index: 1, start: .125, end: 1.25, text: '学习让资讯更清晰。' }, { index: 2, start: 1.25, end: 2.5, text: '再练习。' }]);
  assert.equal(simplified('製作專業影片'), '制作专业影片');
  for (const invalid of ['', '1\nwrong\n字幕', '1\n00:00:02,000 --> 00:00:01,000\n字幕', '1\n00:00:00,000 --> 00:00:01,000\nOnly English']) assert.throws(() => parseSrt(invalid));
  assert.throws(() => parseSrt('1\n00:00:00,000 --> 00:00:02,000\n一句。\n\n2\n00:00:01,000 --> 00:00:03,000\n两句。'), /overlap/);
});

test('brief style names choose distinct layouts and motion; ambiguous styles fail', () => {
  const technology = selectTemplate('做成科技感的视频');
  const education = selectTemplate('风格：教育风\n标题：学会拆解问题');
  const marketing = selectTemplate('采用营销风');
  assert.equal(technology.id, 'technology');
  assert.equal(education.id, 'education');
  assert.equal(marketing.id, 'marketing');
  assert.notDeepEqual(technology.layout, education.layout);
  assert.notDeepEqual(education.palette, marketing.palette);
  assert.notEqual(education.motion.durationSeconds, marketing.motion.durationSeconds);
  assert.equal(selectTemplate('请避免科技感，风格：教育风').id, 'education');
  assert.equal(selectTemplate('普通简报', '营销风').id, 'marketing');
  assert.throws(() => selectTemplate('科技感和教育风'), /multiple/);
  assert.throws(() => selectTemplate('风格：不存在'), /Unknown/);
});

test('edited film rejects unsafe encoding and music parameters before rendering', async () => {
  const work = fileURLToPath(new URL('../work/', import.meta.url));
  mkdirSync(work, { recursive: true });
  const directory = mkdtempSync(path.join(work, 'render-validation-'));
  try {
    for (const changes of [{ width: 641 }, { height: 0 }, { fps: 61 }, { duration: -1 }, { music: { volume: .5 } }, { music: { volume: '1;anull' } }, { backgroundImage: 'https://example.com/image.png' }, { backgroundImage: '../background.png' }]) {
      writeFileSync(path.join(directory, 'film.json'), JSON.stringify({ width: 640, height: 360, fps: 12, duration: 6, ...changes }));
      await assert.rejects(renderProject(directory), /dimensions|duration|Music volume|Background image/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
