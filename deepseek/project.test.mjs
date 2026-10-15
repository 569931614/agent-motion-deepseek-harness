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
  write('work/task-1/render.mjs', "import {renderProject} from '../../deepseek/lib/produce.js';import {fileURLToPath} from 'node:url';await renderProject(fileURLToPath(new URL('.',import.meta.url)));\n");
  write('work/task-1/source.mp4', 'mock media');
  write('work/task-1/final.mp4', 'mock final');
  write('work/task-1/source.srt', '字幕');
  write('work/task-1/assets/background.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  write('work/task-1/assets/config-secret.json', '{"credential":"never export"}');
  write('work/task-1/assets/content.json', '{"title":"编辑内容"}');
  write('work/task-1/assets/settings.json', '{"apiKey":"never export"}');
  write('work/task-1/assets/cloud-settings.json', '{"YIDEVS_API_KEY":"never export"}');
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
  for (const filename of ['scripts', 'serve.mjs', 'LICENSE', 'NOTICE', 'COMMERCIAL-LICENSE.md', 'THIRD_PARTY_NOTICES.md', 'deepseek/lib/srt.js']) cpSync(path.join(root, filename), path.join(directory, filename), { recursive: true });
  for (const dependency of ['three', 'playwright-core', 'opencc-js']) cpSync(path.join(root, 'node_modules', dependency), path.join(directory, 'node_modules', dependency), { recursive: true });
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
    for (const filename of ['work/task-1/scene.mjs', 'work/task-1/film.json', 'work/task-1/index.html', 'work/task-1/render.mjs', 'work/task-1/source.srt', 'work/task-1/assets/background.png', 'work/task-1/assets/content.json', 'inputs/studio/task-1/voice.wav', 'reference-library/typography/fonts/test/OFL.txt', 'scripts/render-project.mjs', 'node_modules/three/build/three.core.js', 'node_modules/three/examples/jsm/geometries/RoundedBoxGeometry.js', 'node_modules/three/src/math/Vector2.js', 'node_modules/playwright-core/index.mjs', 'inputs/studio/task-1/rules/.agents/skills/motion-craft/references/composition.md', '.agents/skills/motion-craft/SKILL.md']) assert.ok(existsSync(path.join(extracted, filename)), filename);
    for (const filename of ['work/task-1/.env', 'work/task-1/voice-request.json', 'work/task-1/assets/config-secret.json', 'work/task-1/assets/settings.json', 'work/task-1/assets/cloud-settings.json', 'inputs/studio/task-1/avatar-request.json', 'work/task-1/frames', 'work/other-task', '.runtime', '.venv', 'deepseek/lib/image.js']) assert.equal(existsSync(path.join(extracted, filename)), false, filename);
    assert.equal(readFileSync(path.join(extracted, 'work/task-1/render.mjs'), 'utf8'), readFileSync(path.join(task, 'render.mjs'), 'utf8'));
    const { startServer } = await import(pathToFileURL(path.join(extracted, 'serve.mjs')));
    const service = await startServer({ port: 0, root: extracted });
    try {
      for (const route of ['/work/task-1/index.html', '/work/task-1/scene.mjs', '/work/task-1/film.json', '/node_modules/three/build/three.module.js', '/node_modules/three/build/three.core.js']) assert.equal((await fetch(service.url + route)).status, 200, route);
    } finally { await new Promise(resolve => service.server.close(resolve)); }
    // Importing and validating the packaged renderer must work without the plugin or cloud modules.
    const { renderProject } = await import(pathToFileURL(path.join(extracted, 'scripts/render-project.mjs')));
    assert.equal((await import(pathToFileURL(path.join(extracted, 'deepseek/lib/produce.js')))).renderProject, renderProject);
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

test('freeform project exports its modules and runs the original render entry without a template schema', async () => {
  const { directory, task, write } = fixture();
  try {
    unlinkSync(path.join(task, 'film.json'));
    unlinkSync(path.join(task, 'scene.mjs'));
    unlinkSync(path.join(task, 'source.mp4'));
    write('work/task-1/index.html', '<!doctype html><link rel="stylesheet" href="./styles/layout.css"><script type="importmap">{"imports":{"three":"../../node_modules/three/build/three.module.js","three/addons/":"../../node_modules/three/examples/jsm/"}}</script><script type="module" src="./modules/main.js"></script>');
    write('work/task-1/styles/layout.css', 'body{background:#112233}');
    write('work/task-1/modules/main.js', "import {makeTitle} from './title.mjs';import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';fetch('../data/timeline.json').then(r=>r.json()).then(data=>document.body.append(makeTitle(data.title)));\n");
    write('work/task-1/modules/title.mjs', "export function makeTitle(text){const e=document.createElement('h1');e.textContent=text;return e;}\n");
    write('work/task-1/data/timeline.json', '{"title":"自由工程"}');
    write('work/task-1/person/cutout.webm', 'arbitrary person layer');
    write('work/task-1/person/metadata.json', '{"kind":"single-transparent-layer"}');
    write('work/task-1/render.mjs', "import './modules/render-film.mjs';\n");
    write('work/task-1/modules/render-film.mjs', "import {writeFileSync} from 'node:fs';writeFileSync(new URL('../author-entry-result.json',import.meta.url),JSON.stringify({authorEntry:true}));\n");
    write('inputs/studio/task-1/voiced-avatar.mp4', 'prepared digital human');
    write('inputs/studio/task-1/alignment/source.srt', 'aligned subtitles');
    write('inputs/studio/task-1/alignment/cache/unused.json', 'must not export');
    write('work/task-1/cache/tmp.json', 'must not export');
    write('work/task-1/runtime/bin/mock.exe', 'must not export');
    write('work/task-1/assets/api-response.json', '{"url":"raw upstream"}');
    const zip = await exportProject(directory, 'task-1'), extracted = path.join(directory, 'freeform');
    unpack(zip, extracted);
    assert.equal(readFileSync(path.join(extracted, 'work/task-1/render.mjs'), 'utf8'), readFileSync(path.join(task, 'render.mjs'), 'utf8'));
    for (const filename of ['work/task-1/modules/main.js', 'work/task-1/modules/title.mjs', 'work/task-1/styles/layout.css', 'work/task-1/data/timeline.json', 'work/task-1/person/cutout.webm', 'work/task-1/person/metadata.json', 'inputs/studio/task-1/voiced-avatar.mp4', 'inputs/studio/task-1/alignment/source.srt']) assert.ok(existsSync(path.join(extracted, filename)), filename);
    for (const filename of ['work/task-1/film.json', 'work/task-1/scene.mjs', 'work/task-1/person/alpha.mp4', 'work/task-1/cache', 'work/task-1/runtime', 'inputs/studio/task-1/alignment/cache', 'work/task-1/assets/api-response.json']) assert.equal(existsSync(path.join(extracted, filename)), false, filename);
    const entry = JSON.parse(readFileSync(path.join(extracted, 'package.json'), 'utf8')).scripts.render;
    assert.equal(entry, 'node work/task-1/render.mjs');
    const rendered = spawnSync(process.execPath, ['work/task-1/render.mjs'], { cwd: extracted, windowsHide: true, encoding: 'utf8' });
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.deepEqual(JSON.parse(readFileSync(path.join(extracted, 'work/task-1/author-entry-result.json'), 'utf8')), { authorEntry: true });
    const { startServer } = await import(pathToFileURL(path.join(extracted, 'serve.mjs')));
    const service = await startServer({ port: 0, root: extracted });
    try {
      for (const route of ['/work/task-1/index.html', '/work/task-1/modules/main.js', '/work/task-1/modules/title.mjs', '/work/task-1/styles/layout.css', '/work/task-1/data/timeline.json', '/node_modules/three/examples/jsm/geometries/RoundedBoxGeometry.js', '/node_modules/three/src/math/Vector2.js']) assert.equal((await fetch(service.url + route)).status, 200, route);
    } finally { await new Promise(resolve => service.server.close(resolve)); }
    unlinkSync(path.join(task, 'render.mjs'));
    await assert.rejects(exportProject(directory, 'task-1'), /Required project file.*render\.mjs/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('export rejects task traversal, linked media and escaped font dependencies', async () => {
  const { directory, task, write } = fixture();
  const outside = mkdtempSync(path.join(tmpdir(), 'motion-project-outside-'));
  try {
    for (const id of ['../other-task', 'C:/private', 'task\\other', '']) await assert.rejects(exportProject(directory, id), /task ID/);
    const scene = readFileSync(path.join(task, 'scene.mjs'));
    unlinkSync(path.join(task, 'scene.mjs'));
    for (const html of ['<title>No source</title>', '<script type="module">\n </script>', '<script data-type="module">ignored</script>', '<script type="module" src="missing.js">ignored</script>']) {
      write('work/task-1/index.html', html);
      await assert.rejects(exportProject(directory, 'task-1'), /Editable project source is missing/);
    }
    write('work/task-1/index.html', '<title>Inline</title><script type="module">document.body.append("可编辑预览");</script>');
    unlinkSync(path.join(task, 'film.json'));
    const inlineZip = await exportProject(directory, 'task-1'), inlineProject = path.join(directory, 'inline');
    unpack(inlineZip, inlineProject);
    assert.match(readFileSync(path.join(inlineProject, 'work/task-1/index.html'), 'utf8'), /document\.body\.append/);
    assert.equal(existsSync(path.join(inlineProject, 'work/task-1/film.json')), false);
    write('work/task-1/scene.mjs', scene);
    writeFileSync(path.join(outside, 'foreground.mp4'), 'never export');
    write('work/task-1/film.json', JSON.stringify({ keepBackground: false }));
    symlinkSync(outside, path.join(task, 'person'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(exportProject(directory, 'task-1'), /allowed directory|Linked/);
    rmSync(path.join(task, 'person'));
    const fontDirectory = path.join(directory, 'reference-library/typography/fonts/test');
    rmSync(fontDirectory, { recursive: true });
    symlinkSync(outside, fontDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(exportProject(directory, 'task-1'), /allowed directory|Linked/);
    // Directory junctions must not permit switching this task to another task's outputs.
    const linked = path.join(directory, 'work', 'linked');
    symlinkSync(task, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(exportProject(directory, 'linked'), /task boundary/);
  } finally { rmSync(directory, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
