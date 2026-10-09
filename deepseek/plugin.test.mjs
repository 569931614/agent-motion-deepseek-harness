import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { SkillRegistry } from '@deepseek-ai/dsh-skill';
import * as plugin from './lib/index.js';
import { createWorkspace } from './create-workspace.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const skillNames = ['agent-motion', 'motion-craft', 'srt-reference-to-three'];

test('native Harness plugin exposes complete skills and disposes its provider', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(SkillRegistry);
    const fiber = await ctx.plugin(plugin);
    const catalog = await ctx.skills.list();
    assert.deepEqual(catalog.map(skill => skill.name), skillNames);
    for (const name of skillNames) {
      const directory = path.join(root, '.agents', 'skills', name);
      const instruction = path.join(directory, 'SKILL.md');
      const expected = readFileSync(instruction, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '').trim();
      const skill = await ctx.skills.get(name);
      assert.equal(skill.content, expected, `${name}: full instruction body`);
      assert.equal(skill.path, instruction);
      assert.equal(skill.provider, 'agent-motion');
      assert.equal(skill.source, 'bundled');
      assert.deepEqual(skill.resourceBase, { kind: 'directory', path: directory });
      assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true });
      assert.equal(catalog.find(entry => entry.name === name).path, instruction);
    }
    await fiber.dispose();
    assert.deepEqual(await ctx.skills.list(), []);
    for (const name of skillNames) assert.equal(await ctx.skills.get(name), undefined);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('independent workspace preserves inputs, production resources and relocated commands', t => {
  const temporaryParent = realpathSync(tmpdir());
  const temporary = mkdtempSync(path.join(temporaryParent, 'agent-motion plugin-'));
  t.after(() => {
    // Delete only this test's owned, canonical directory beneath the native temp root.
    assert.equal(path.dirname(realpathSync(temporary)), temporaryParent);
    rmSync(temporary, { recursive: true, force: true });
  });
  const target = path.join(temporary, 'film workspace with spaces');
  assert.equal(createWorkspace(target), target);
  for (const resource of [
    'AGENTS.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'serve.mjs',
    'scripts/bootstrap.mjs', 'scripts/setup.mjs', 'scripts/browser.mjs',
    'scripts/matte.py', 'scripts/requirements-matting.txt', 'scripts/rvm-model.json',
    'scripts/read-stage.mjs', 'tests/fixtures/smoke.html', 'inputs/README.md',
    'docs/getting-started.md', 'docs/compatibility.md',
    'docs/image-generation.md', 'deepseek/lib/image.js', 'deepseek/scene.mjs',
    '.agents/skills/motion-craft/scripts/read-stage.py',
    'reference-library/analysis/catalog.json',
    'reference-library/typography/fonts/notosanssc/NotoSansSC[wght].ttf',
    'reference-library/typography/fonts/notosanssc/OFL.txt',
    ...skillNames.filter(name => name !== 'agent-motion').map(name => `.agents/skills/${name}/SKILL.md`),
  ]) {
    assert.deepEqual(readFileSync(path.join(target, resource)), readFileSync(path.join(root, resource)), resource);
  }
  const manifest = JSON.parse(readFileSync(path.join(target, 'package.json'), 'utf8'));
  assert.ok(!existsSync(path.join(target, '.agents/skills/agent-motion')));
  const lock = JSON.parse(readFileSync(path.join(target, 'package-lock.json'), 'utf8'));
  const sourceLock = JSON.parse(readFileSync(path.join(root, 'npm-shrinkwrap.json'), 'utf8'));
  assert.deepEqual(Object.keys(lock.packages).sort(), ['', 'node_modules/opencc-js', 'node_modules/playwright-core', 'node_modules/three']);
  for (const dependency of ['opencc-js', 'playwright-core', 'three']) {
    assert.deepEqual(lock.packages[`node_modules/${dependency}`], sourceLock.packages[`node_modules/${dependency}`]);
  }
  assert.deepEqual(manifest.dependencies, { three: '0.186.0', 'playwright-core': '1.63.0', 'opencc-js': '1.4.2' });
  for (const key of ['peerDependencies', 'devDependencies', 'dsh']) assert.equal(manifest[key], undefined);
  for (const key of ['peerDependencies', 'devDependencies']) assert.equal(lock.packages[''][key], undefined);
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
  assert.equal(manifest.scripts['test:plugin'], undefined);
  assert.equal(manifest.scripts.image, 'node deepseek/lib/image.js');
  for (const [name, entry] of Object.entries(lock.packages)) {
    assert.ok(!name.includes('node_modules/@deepseek-ai/'), `Harness dependency leaked: ${name}`);
    assert.ok(!entry.dev && !entry.peer, `Non-production lock entry: ${name}`);
  }
  const existing = path.join(temporary, 'user materials');
  mkdirSync(existing);
  const sentinel = path.join(existing, 'original.mp4');
  writeFileSync(sentinel, 'preserve original footage');
  assert.throws(() => createWorkspace(existing), { code: 'EEXIST' });
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserve original footage');
  const empty = path.join(temporary, 'existing empty');
  mkdirSync(empty);
  assert.throws(() => createWorkspace(empty), { code: 'EEXIST' });
  const linked = path.join(temporary, 'linked materials');
  symlinkSync(existing, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => createWorkspace(linked), { code: 'EEXIST' });
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserve original footage');
  const forbidden = path.join(root, 'deepseek', path.basename(temporary));
  assert.ok(!existsSync(forbidden));
  assert.throws(() => createWorkspace(forbidden), /outside the plugin installation directory/);
  assert.ok(!existsSync(forbidden));
  for (const [script, argument, marker] of [
    ['scripts/read-stage.mjs', '--list', /srt[\s\S]*assets[\s\S]*composition/],
    ['scripts/bootstrap.mjs', '--plan', /npm ci[\s\S]*requirements-matting\.txt/],
  ]) {
    const result = spawnSync(process.execPath, [script, argument], {
      cwd: target, encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    assert.match(result.stdout, marker);
  }
  for (const directory of ['.runtime', '.venv', 'node_modules']) assert.ok(!existsSync(path.join(target, directory)));
});
