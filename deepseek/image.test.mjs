import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { generateImages, imageExtension, imageCli } from './lib/image.js';

const apiRoot = 'https://api.aa.com.cn/api/v1';
const testKey = 'aa-mock-secret-never-a-real-credential';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1cAAAAASUVORK5CYII=', 'base64');
function pngChunk(type, data) {
  const tag = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([tag, data])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, tag, data, checksum]);
}
// A real, decodable 32×32 RGBA PNG passes the provider's reference-size preflight.
const referencePng = (() => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(32); header.writeUInt32BE(32, 4);
  header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc(32 * (1 + 32 * 4), 255);
  for (let row = 0; row < 32; row++) rows[row * (1 + 32 * 4)] = 0;
  return Buffer.concat([png.subarray(0, 8), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
})();
const work = fileURLToPath(new URL('../work/', import.meta.url));
const reply = data => Response.json({ code: 0, data, request_id: 'mock-request' });
const picture = () => new Response(png, { headers: { 'Content-Type': 'image/png' } });

function sandbox(t) {
  mkdirSync(work, { recursive: true });
  const canonicalWork = realpathSync(work);
  const directory = realpathSync(mkdtempSync(path.join(canonicalWork, 'image-api-test-')));
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.AA_API_KEY;
  const originalLog = console.log;
  const originalError = console.error;
  const calls = [], logs = [];
  let handler = () => { throw new Error('Unexpected mock request: real network is disabled.'); };
  process.env.AA_API_KEY = testKey;
  console.log = (...values) => logs.push(values.map(String).join(' '));
  console.error = (...values) => logs.push(values.map(String).join(' '));
  globalThis.fetch = async (input, options = {}) => {
    const call = {
      url: String(input), method: options.method ?? 'GET',
      headers: new Headers(options.headers), body: options.body ? JSON.parse(options.body) : undefined,
      signal: options.signal, redirect: options.redirect,
    };
    calls.push(call);
    return handler(call);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    if (originalKey === undefined) delete process.env.AA_API_KEY;
    else process.env.AA_API_KEY = originalKey;
    const canonical = realpathSync(directory);
    assert.equal(canonical, directory);
    assert.equal(path.dirname(canonical), canonicalWork);
    assert.ok(path.basename(canonical).startsWith('image-api-test-'));
    rmSync(canonical, { recursive: true, force: false });
  });
  return {
    directory, calls, logs, output: name => path.join(directory, name),
    mock(next) { calls.length = 0; handler = next; },
  };
}

function taskAt(directory) { return JSON.parse(readFileSync(path.join(directory, 'task.json'), 'utf8')); }
function assertNoSecret(s) {
  assert.ok(s.logs.every(value => !value.includes(testKey)));
  function inspect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) inspect(filename);
      else assert.ok(!readFileSync(filename).includes(Buffer.from(testKey)), `Credential persisted in ${entry.name}`);
    }
  }
  inspect(s.directory);
}

test('single image submits once, polls the AA task endpoint, and downloads without Bearer auth', { concurrency: false }, async t => {
  const s = sandbox(t);
  const output = s.output('single');
  s.mock(call => {
    if (call.method === 'POST') {
      assert.equal(call.url, `${apiRoot}/image/generation`);
      assert.equal(call.headers.get('Authorization'), `Bearer ${testKey}`);
      assert.equal(call.headers.get('Content-Type'), 'application/json');
      assert.equal(call.redirect, 'error');
      assert.deepEqual(call.body, {
        model: 'doubao-seedream-4-0-250828', prompt: '科技感背景', size: '2848x1600',
        response_format: 'url', stream: false, sequential_image_generation: 'disable',
      });
      return reply({ task_id: 'task / one', task_status: 'pending' });
    }
    if (call.url === `${apiRoot}/task/task%20%2F%20one`) {
      assert.equal(call.headers.get('Authorization'), `Bearer ${testKey}`);
      return reply({ task_status: 'completed', urls: ['https://storage.example/image.png'], usage: { images: 1 } });
    }
    assert.equal(call.url, 'https://storage.example/image.png');
    assert.equal(call.headers.get('Authorization'), null);
    assert.equal(call.redirect, 'manual');
    return picture();
  });
  const files = await generateImages({ output, prompt: '  科技感背景  ', timeoutMs: 1000, pollMs: 1 });
  assert.deepEqual(s.calls.map(call => call.method), ['POST', 'GET', 'GET']);
  assert.deepEqual(files, [path.join(output, 'image-1.png')]);
  assert.deepEqual(readFileSync(files[0]), png);
  assert.equal(imageExtension(png), 'png');
  assert.equal(readFileSync(path.join(output, 'prompt.txt'), 'utf8'), '科技感背景\n');
  assert.deepEqual(taskAt(output).files, ['image-1.png']);
  assert.equal(taskAt(output).status, 'downloaded-awaiting-visual-review');
  assertNoSecret(s);
});

test('multiple local references and grouped direct results stay bounded and use raster data URIs', { concurrency: false }, async t => {
  const s = sandbox(t);
  const references = ['reference-a.png', 'reference-b.png'].map(name => s.output(name));
  references.forEach(filename => writeFileSync(filename, referencePng));
  s.mock(call => {
    if (call.method === 'POST') {
      assert.equal(call.url, `${apiRoot}/image/generation`);
      assert.equal(call.body.model, 'doubao-seedream-4-5-251128');
      assert.equal(call.body.size, '2K');
      assert.equal(call.body.watermark, false);
      assert.equal(call.body.sequential_image_generation, 'auto');
      assert.deepEqual(call.body.sequential_image_generation_options, { max_images: 2 });
      assert.deepEqual(call.body.image, references.map(() => `data:image/png;base64,${referencePng.toString('base64')}`));
      return reply({ urls: ['https://storage.example/one', 'https://storage.example/two'] });
    }
    assert.ok(call.url.startsWith('https://storage.example/'));
    assert.equal(call.headers.get('Authorization'), null);
    return picture();
  });
  const output = s.output('group');
  const files = await generateImages({ output, prompt: '参考产品做场景', references, maxImages: 2, model: 'doubao-seedream-4-5-251128', size: '2K', watermark: false, timeoutMs: 1000 });
  assert.deepEqual(files, [path.join(output, 'image-1.png'), path.join(output, 'image-2.png')]);
  assert.equal(s.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(s.calls.filter(call => call.url.startsWith(`${apiRoot}/task/`)).length, 0);
  assert.deepEqual(taskAt(output).files, ['image-1.png', 'image-2.png']);
  assertNoSecret(s);
});

test('HTTP, task failure, and submission or polling timeout keep recovery files without another paid POST', { concurrency: false }, async t => {
  const s = sandbox(t);
  const httpOutput = s.output('http-failure');
  s.mock(() => new Response(`provider echoed ${testKey}`, { status: 401 }));
  await assert.rejects(generateImages({ output: httpOutput, prompt: '测试', timeoutMs: 100 }), /HTTP 401/);
  assert.equal(s.calls.length, 1);
  assert.equal(taskAt(httpOutput).status, 'submission-uncertain');
  assert.ok(existsSync(path.join(httpOutput, 'prompt.txt')));

  const failedOutput = s.output('task-failure');
  s.mock(call => call.method === 'POST' ? reply({ task_id: 'failed-task', task_status: 'pending' }) : reply({ task_status: 'failed' }));
  await assert.rejects(generateImages({ output: failedOutput, prompt: '测试', timeoutMs: 1000, pollMs: 1 }), /task failed/);
  assert.equal(s.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(taskAt(failedOutput).taskId, 'failed-task');
  assert.equal(taskAt(failedOutput).status, 'failed');

  const uncertainOutput = s.output('submit-timeout');
  s.mock(call => new Promise((resolve, reject) => {
    assert.equal(call.method, 'POST');
    call.signal.addEventListener('abort', () => reject(new Error(`submission timed out with ${testKey}`)), { once: true });
  }));
  // AbortSignal.timeout uses an unref'ed timer; keep the event loop alive in this mock.
  const keepAlive = setInterval(() => {}, 20);
  try {
    await assert.rejects(generateImages({ output: uncertainOutput, prompt: '测试', timeoutMs: 15 }), error => {
      assert.match(error.message, /timed out/);
      assert.ok(!error.message.includes(testKey));
      assert.match(error.message, /\[redacted\]/);
      return true;
    });
  } finally { clearInterval(keepAlive); }
  assert.equal(s.calls.length, 1);
  assert.equal(taskAt(uncertainOutput).status, 'submission-uncertain');
  await assert.rejects(generateImages({ output: uncertainOutput, resume: true, timeoutMs: 100 }), /No saved task ID/);
  assert.equal(s.calls.length, 1);

  const pollingOutput = s.output('poll-timeout');
  s.mock(() => reply({ task_id: 'still-pending', task_status: 'pending' }));
  await assert.rejects(generateImages({ output: pollingOutput, prompt: '测试', timeoutMs: 80, pollMs: 1 }), /timed out/);
  assert.equal(s.calls.filter(call => call.method === 'POST').length, 1);
  assert.ok(s.calls.some(call => call.method === 'GET'));
  assert.equal(taskAt(pollingOutput).taskId, 'still-pending');
  assertNoSecret(s);
});

test('resume refreshes expired URLs through GET, preserves an already downloaded image, and supports the CLI', { concurrency: false }, async t => {
  const s = sandbox(t);
  const output = s.output('resume');
  s.mock(call => {
    if (call.method === 'POST') return reply({ task_id: 'resume-task', task_status: 'completed', urls: ['https://storage.example/old-one', 'https://storage.example/old-two'] });
    if (call.url.endsWith('/old-one')) return picture();
    assert.equal(call.url, 'https://storage.example/old-two');
    return new Response('Expired link', { status: 403 });
  });
  await assert.rejects(generateImages({ output, prompt: '两张参考背景', maxImages: 2, timeoutMs: 1000 }), /download HTTP 403/);
  const first = readFileSync(path.join(output, 'image-1.png'));
  assert.deepEqual(taskAt(output).files, ['image-1.png']);
  s.mock(call => {
    assert.equal(call.method, 'GET');
    if (call.url === `${apiRoot}/task/resume-task`) {
      assert.equal(call.headers.get('Authorization'), `Bearer ${testKey}`);
      return reply({ task_status: 'completed', urls: ['https://storage.example/new-one', 'https://storage.example/new-two'] });
    }
    assert.equal(call.url, 'https://storage.example/new-two');
    assert.equal(call.headers.get('Authorization'), null);
    return picture();
  });
  await imageCli(['--resume', '--output', output, '--timeout-seconds', '1']);
  assert.deepEqual(s.calls.map(call => call.url), [`${apiRoot}/task/resume-task`, 'https://storage.example/new-two']);
  assert.deepEqual(readFileSync(path.join(output, 'image-1.png')), first);
  assert.deepEqual(taskAt(output).files, ['image-1.png', 'image-2.png']);
  assert.equal(taskAt(output).status, 'downloaded-awaiting-visual-review');
  assertNoSecret(s);
});

test('missing credentials, invalid dimensions, excess images, and existing directories fail before submission', { concurrency: false }, async t => {
  const s = sandbox(t);
  delete process.env.AA_API_KEY;
  const absentOutput = s.output('missing-key');
  await assert.rejects(generateImages({ output: absentOutput, prompt: '测试' }), /AA_API_KEY/);
  assert.ok(!existsSync(absentOutput));
  process.env.AA_API_KEY = testKey;
  const tinyReference = s.output('tiny-reference.png');
  writeFileSync(tinyReference, png);
  for (const [name, changes, pattern] of [
    ['bad-size', { size: '1x1' }, /size/],
    ['bad-model', { model: 'unsupported-model' }, /model ID/],
    ['too-many', { maxImages: 16 }, /max-images/],
    ['too-many-references', { references: Array(15).fill('unused.png') }, /14 reference/],
    ['tiny-reference', { references: [tinyReference] }, /Reference image.*pixel/],
  ]) {
    const output = s.output(name);
    await assert.rejects(generateImages({ output, prompt: '测试', ...changes }), pattern);
    assert.ok(!existsSync(output));
  }
  const existing = s.output('existing');
  mkdirSync(existing);
  writeFileSync(path.join(existing, 'keep.txt'), 'user asset');
  await assert.rejects(generateImages({ output: existing, prompt: '测试' }), /EEXIST/);
  assert.equal(readFileSync(path.join(existing, 'keep.txt'), 'utf8'), 'user asset');
  assert.ok(!existsSync(path.join(existing, 'task.json')));
  assert.equal(s.calls.length, 0);
  assertNoSecret(s);
});

test('HTML masquerading as an image, unsafe URLs, and unsafe redirects are rejected without leaking provider secrets', { concurrency: false }, async t => {
  const s = sandbox(t);
  for (const [name, url, pattern] of [
    ['http-url', 'http://storage.example/image.png', /HTTPS/],
    ['credentials-url', 'https://user:password@storage.example/image.png', /embedded credentials/],
    ['html-image', 'https://storage.example/html', /PNG, JPEG or WebP/],
    ['unsafe-redirect', 'https://storage.example/redirect', /HTTPS/],
  ]) {
    const output = s.output(name);
    s.mock(call => {
      if (call.method === 'POST') return reply({ urls: [url] });
      assert.equal(call.headers.get('Authorization'), null);
      if (name === 'unsafe-redirect') return new Response(null, { status: 302, headers: { Location: 'http://storage.example/insecure' } });
      assert.equal(name, 'html-image');
      return new Response('<html>This is not a picture.</html>', { headers: { 'Content-Type': 'image/png' } });
    });
    await assert.rejects(generateImages({ output, prompt: '测试', timeoutMs: 100 }), pattern);
    assert.equal(s.calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(s.calls.length, name === 'html-image' || name === 'unsafe-redirect' ? 2 : 1);
    assert.ok(existsSync(path.join(output, 'task.json')));
    assert.ok(!readdirSync(output).some(filename => /^image-/.test(filename)));
  }
  const output = s.output('provider-secret');
  s.mock(() => Response.json({ code: 1001, data: { message: testKey }, message: `bad token ${testKey}` }));
  await assert.rejects(generateImages({ output, prompt: '测试', timeoutMs: 100 }), error => {
    assert.match(error.message, /unsuccessful or invalid/);
    assert.ok(!error.message.includes(testKey));
    return true;
  });
  assert.equal(s.calls.length, 1);
  s.mock(() => new Response(`not-json-${testKey}`));
  await assert.rejects(generateImages({ output: s.output('invalid-json'), prompt: '测试', timeoutMs: 100 }), error => {
    assert.match(error.message, /invalid JSON/);
    assert.ok(!error.message.includes(testKey) && !error.message.includes('not-json-'));
    return true;
  });
  assert.equal(s.calls.length, 1);
  assertNoSecret(s);
});
