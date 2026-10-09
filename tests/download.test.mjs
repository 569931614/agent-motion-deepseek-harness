import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { downloadVerified } from '../scripts/download.mjs';
const payload = Buffer.from('verified model fixture');
const asset = { url: 'https://example.invalid/model.onnx', bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') };

test('verified cache avoids a network request', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'download test '));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const filename = path.join(folder, 'model');
  await writeFile(filename, payload);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('network must not be used'); });
  await downloadVerified(asset, filename);
  assert.deepEqual(await readFile(filename), payload);
});
test('bad download never replaces existing data and leaves no partial executable', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'download test '));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const filename = path.join(folder, 'model');
  await writeFile(filename, 'previous cache');
  t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.alloc(payload.length)));
  await assert.rejects(downloadVerified(asset, filename), /checksum/);
  assert.equal(await readFile(filename, 'utf8'), 'previous cache');
  assert.deepEqual(await readdir(folder), ['model']);
});
test('verified download installs only complete matching bytes', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'download test '));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const filename = path.join(folder, 'model');
  t.mock.method(globalThis, 'fetch', async () => new Response(payload));
  await downloadVerified(asset, filename);
  assert.deepEqual(await readFile(filename), payload);
});
test('untrusted transport and missing digest are rejected before fetch', async () => {
  await assert.rejects(downloadVerified({ ...asset, url: 'http://example.invalid/model' }, 'unused'), /HTTPS/);
  await assert.rejects(downloadVerified({ ...asset, sha256: '' }, 'unused'), /SHA-256/);
});
test('Windows network fallback uses a unique temporary file and still verifies bytes', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'download fallback 空格 '));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const filename = path.join(folder, 'model');
  await writeFile(filename, 'previous cache');
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(payload.subarray(0, 3));
    setTimeout(() => controller.error(new TypeError('terminated')), 10);
  } })));
  const windowsDownload = t.mock.fn(async (url, temporary) => {
    assert.equal(url, asset.url);
    assert.ok(temporary.startsWith(filename + '.') && temporary.endsWith('.part'));
    assert.deepEqual(await readdir(folder), ['model'], 'The partial Node download must be removed before fallback.');
    await writeFile(temporary, payload, { flag: 'wx' });
  });
  await downloadVerified(asset, filename, { platform: 'win32', windowsDownload });
  assert.equal(windowsDownload.mock.callCount(), 1);
  assert.deepEqual(await readFile(filename), payload);
  assert.deepEqual(await readdir(folder), ['model']);

  await writeFile(filename, 'previous cache');
  await assert.rejects(downloadVerified(asset, filename, { platform: 'win32', windowsDownload: async (_, temporary) => writeFile(temporary, Buffer.alloc(payload.length)) }), /checksum/);
  assert.equal(await readFile(filename, 'utf8'), 'previous cache');
  assert.deepEqual(await readdir(folder), ['model']);
});
test('HTTP, checksum and non-Windows failures never invoke Windows fallback', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'download fallback '));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const filename = path.join(folder, 'model');
  const windowsDownload = t.mock.fn(() => { throw new Error('fallback must not run'); });
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 403 }));
  await assert.rejects(downloadVerified(asset, filename, { platform: 'win32', windowsDownload }), /HTTP 403/);
  fetch.mock.mockImplementation(async () => new Response(Buffer.alloc(payload.length)));
  await assert.rejects(downloadVerified(asset, filename, { platform: 'win32', windowsDownload }), /checksum/);
  fetch.mock.mockImplementation(async () => { throw new DOMException('connection timed out', 'TimeoutError'); });
  await assert.rejects(downloadVerified(asset, filename, { platform: 'linux', windowsDownload }), /timed out/);
  assert.equal(windowsDownload.mock.callCount(), 0);
  assert.deepEqual(await readdir(folder), []);
});
