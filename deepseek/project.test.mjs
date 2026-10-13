import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportProject } from './lib/project.js';
import { findPython } from '../scripts/runtime.mjs';

const root = path.resolve(import.meta.dirname, '..');
const python = findPython();
function unpack(zip, destination) {
  const result = spawnSync(python.command, [...python.prefix, '-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z: z.extractall(sys.argv[2])', zip, destination], { windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'motion-project-'));
  const task = path.join(directory, 'work', 'task-1');
  mkdirSync(task, { recursive: true });
  const write = (name, value) => { const file = path.join(directory, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, value); };
  write('work/task-1/film.json', JSON.stringify({ width: 640, height: 360, fps: 12, duration: 1, keepBackground: true, style: { typography: { bodyFontPath: 'reference-library/typography/fonts/test/font.ttf' } } }));
  write('work/task-1/index.html', '<!doctype html><script type="importmap">{"imports":{"three":"../../node_modules/three/build/three.module.js"}}</script><script type="module">import {mount} from "./scene.mjs";mount();</script>');
  write('work/task-1/scene.mjs', "import * as THREE from 'three';export function mount(){window.film={renderAt:async t=>t};window.scene=new THREE.Scene();}");
  write('work/task-1/source.mp4', 'mock media');
  write('work/task-1/final.mp4', 'mock final');
  write('work/task-1/source.srt', '字幕');
  write('work/task-1/assets/background.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  write('work/task-1/assets/config-secret.json', '{"credential":"never export"}');
  write('work/task-1/.env', 'NEVER_EXPORT=secret');
  write('work/task-1/voice-request.json', '{"secret":"never export"}');
  write('work/task-1/frames/frame-000000.png', 'excluded');
  write('work/other-task/secret.mp4', 'other task must be absent');
  write('inputs/studio/task-1/source.mp4', 'original person');
  write('inputs/studio/task-1/voice.wav', 'original voice');
  write('inputs/studio/task-1/avatar-request.json', '{"secret":"never export"}');
  write('inputs/studio/task-1/rules/AGENTS.md', 'task rules');
  write('inputs/studio/task-1/rules/.agents/skills/motion-craft/SKILL.md', 'current rules');
  write('inputs/studio/task-1/rules/.agents/skills/motion-craft/references/composition.md', 'complete rule reference');
  write('inputs/studio/task-1/rules/revision.json', '{"revision":"snapshot-1"}');
  write('reference-library/typography/fonts/test/font.ttf', 'test font');
  write('reference-library/typography/fonts/test/OFL.txt', 'font license');
  for (const dependency of ['three', 'playwright-core']) cpSync(path.join(root, 'node_modules', dependency), path.join(directory, 'node_modules', dependency), { recursive: true });
  return { directory, task, write };
}

test('project ZIP is self contained, excludes private/shared files and refreshes edits', async () => {
  const { directory, task, write } = fixture();
  try {
    const outputs = await Promise.all([exportProject(directory, 'task-1'), exportProject(directory, 'task-1')]);
    assert.equal(outputs[0], outputs[1]);
    const before = readFileSync(outputs[0]);
    const extracted = path.join(directory, 'unpacked');
    unpack(outputs[0], extracted);
    for (const filename of ['work/task-1/scene.mjs', 'work/task-1/film.json', 'work/task-1/index.html', 'work/task-1/render.mjs', 'work/task-1/source.srt', 'work/task-1/assets/background.png', 'inputs/studio/task-1/voice.wav', 'reference-library/typography/fonts/test/OFL.txt', 'scripts/render-project.mjs', 'node_modules/three/build/three.core.js', 'node_modules/playwright-core/index.mjs', 'inputs/studio/task-1/rules/.agents/skills/motion-craft/references/composition.md', '.agents/skills/motion-craft/SKILL.md']) assert.ok(existsSync(path.join(extracted, filename)), filename);
    for (const filename of ['work/task-1/.env', 'work/task-1/voice-request.json', 'work/task-1/assets/config-secret.json', 'inputs/studio/task-1/avatar-request.json', 'work/task-1/frames', 'work/other-task', '.runtime', '.venv', 'deepseek/lib/image.js']) assert.equal(existsSync(path.join(extracted, filename)), false, filename);
    const { startServer } = await import(pathToFileURL(path.join(extracted, 'serve.mjs')));
    const service = await startServer({ port: 0, root: extracted });
    try {
      for (const route of ['/work/task-1/index.html', '/work/task-1/scene.mjs', '/work/task-1/film.json', '/node_modules/three/build/three.module.js', '/node_modules/three/build/three.core.js']) assert.equal((await fetch(service.url + route)).status, 200, route);
    } finally { await new Promise(resolve => service.server.close(resolve)); }
    // Importing and validating the packaged renderer must work without the plugin or cloud modules.
    const { renderProject } = await import(pathToFileURL(path.join(extracted, 'scripts/render-project.mjs')));
    writeFileSync(path.join(extracted, 'work/task-1/film.json'), JSON.stringify({ width: 641, height: 360, fps: 12, duration: 1 }));
    await assert.rejects(renderProject(path.join(extracted, 'work/task-1')), /dimensions/);
    write('work/task-1/scene.mjs', readFileSync(path.join(task, 'scene.mjs'), 'utf8') + '\n// changed design');
    const changed = await exportProject(directory, 'task-1');
    assert.notDeepEqual(readFileSync(changed), before);
    unlinkSync(path.join(task, 'assets/background.png'));
    await exportProject(directory, 'task-1');
    const updated = path.join(directory, 'updated');
    unpack(changed, updated);
    assert.equal(existsSync(path.join(updated, 'work/task-1/assets/background.png')), false);
    assert.match(readFileSync(path.join(updated, 'work/task-1/scene.mjs'), 'utf8'), /changed design/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('export rejects task traversal, linked media and escaped font dependencies', async () => {
  const { directory, task, write } = fixture();
  const outside = mkdtempSync(path.join(tmpdir(), 'motion-project-outside-'));
  try {
    for (const id of ['../other-task', 'C:/private', 'task\\other', '']) await assert.rejects(exportProject(directory, id), /task ID/);
    writeFileSync(path.join(outside, 'foreground.mp4'), 'never export');
    write('work/task-1/film.json', JSON.stringify({ keepBackground: false }));
    symlinkSync(outside, path.join(task, 'person'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(exportProject(directory, 'task-1'), /allowed directory|Linked/);
    rmSync(path.join(task, 'person'));
    write('work/task-1/film.json', JSON.stringify({ keepBackground: true, style: { typography: { bodyFontPath: 'reference-library/typography/../../work/other-task/secret.mp4' } } }));
    await assert.rejects(exportProject(directory, 'task-1'), /Unsafe project dependency/);
    // Directory junctions must not permit switching this task to another task's outputs.
    const linked = path.join(directory, 'work', 'linked');
    symlinkSync(task, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(exportProject(directory, 'linked'), /task boundary/);
  } finally { rmSync(directory, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
