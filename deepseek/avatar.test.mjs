import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAvatar, uploadPrivateMedia, configurationError, avatarConfigured, validateCosEndpoint, validateCosBucket, AvatarError } from './lib/avatar.js';

const apiRoot = 'https://api.yidevs.com/app/human/human/Musetalk';
const resultUrl = 'https://result.example/avatar.mp4';
const baseTime = 1700000000000;
// Fixed digests below come from Tencent's cos-nodejs-sdk-v5@3.0.0 sdk/util.js
// getAuth oracle (SHA-256 075fe520eab6fd9bd3bb43e9d155c381e968f648dd7ea724e4d6c233c1565e4a).
// The unchanged SDK source and input/output vectors are in work/studio-qa;
// tests contain no duplicate signing algorithm or SDK dependency.
const work = fileURLToPath(new URL('../work/', import.meta.url));
const credentials = {
  YIDEVS_API_KEY: 'avatar-mock-api-key-never-a-real-credential',
  MOTION_OSS_ENDPOINT: 'https://cos.ap-guangzhou.myqcloud.com',
  MOTION_OSS_BUCKET: 'avatar-mock-bucket-1250000000',
  MOTION_OSS_ACCESS_KEY_ID: 'avatar-mock-access-id',
  MOTION_OSS_ACCESS_KEY_SECRET: 'avatar-mock-access-secret',
};
const envKeys = [...Object.keys(credentials), 'MOTION_OSS_SECURITY_TOKEN'];
const mp4 = Buffer.alloc(32);
mp4.writeUInt32BE(32); mp4.write('ftyp', 4); mp4.write('isom', 8);
const reply = data => Response.json({ code: 200, data });
const movie = () => new Response(mp4, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(mp4.length) } });
const errorCode = code => error => { assert.ok(error instanceof AvatarError); assert.equal(error.code, code); for (const key of ['YIDEVS_API_KEY', 'MOTION_OSS_ACCESS_KEY_ID', 'MOTION_OSS_ACCESS_KEY_SECRET']) assert.ok(!error.message.includes(credentials[key])); return true; };

function cosAuthorization(value, method, configured = credentials, token = configured.MOTION_OSS_SECURITY_TOKEN) {
  const fields = value instanceof URLSearchParams ? value : new URLSearchParams(value);
  const start = Math.floor(baseTime / 1000) - 1, end = start + (method === 'GET' ? 10800 : 900);
  assert.equal(fields.get('q-sign-algorithm'), 'sha1'); assert.equal(fields.get('q-ak'), configured.MOTION_OSS_ACCESS_KEY_ID);
  assert.equal(fields.get('q-sign-time'), `${start};${end}`); assert.equal(fields.get('q-key-time'), `${start};${end}`);
  assert.equal(fields.get('q-header-list'), method === 'GET' ? 'host' : `content-length;content-type;host;x-cos-acl${token ? ';x-cos-security-token' : ''}`);
  assert.equal(fields.get('q-url-param-list'), method === 'GET' && token ? 'x-cos-security-token' : '');
  assert.match(fields.get('q-signature'), /^[a-f0-9]{40}$/);
  return fields;
}
function cosGet(value, object, configured = credentials, token = configured.MOTION_OSS_SECURITY_TOKEN) {
  const url = new URL(value);
  assert.equal(url.origin, `https://${configured.MOTION_OSS_BUCKET}.${new URL(configured.MOTION_OSS_ENDPOINT).hostname}`);
  assert.equal(decodeURIComponent(url.pathname), '/' + object);
  cosAuthorization(url.searchParams, 'GET', configured, token);
  assert.equal(url.searchParams.get('x-cos-security-token'), token ?? null);
  for (const field of ['Expires', 'OSSAccessKeyId', 'Signature', 'security-token']) assert.equal(url.searchParams.get(field), null);
  return url;
}
function cosPut(upload, source, configured = credentials, token = configured.MOTION_OSS_SECURITY_TOKEN) {
  const headers = new Headers(upload.headers);
  assert.equal(headers.get('x-cos-acl'), 'private'); assert.equal(headers.get('content-length'), String(source.bytes));
  assert.equal(headers.get('content-type'), source.contentType); assert.equal(headers.get('date'), new Date(baseTime).toUTCString());
  assert.equal(headers.get('x-cos-security-token'), token ?? null);
  assert.equal(headers.get('x-oss-object-acl'), null); assert.equal(headers.get('x-oss-security-token'), null);
  cosAuthorization(upload.headers.Authorization, 'PUT', configured, token);
  const url = new URL(upload.url); assert.equal(decodeURIComponent(url.pathname), '/' + source.object);
  assert.equal(url.origin, `https://${configured.MOTION_OSS_BUCKET}.${new URL(configured.MOTION_OSS_ENDPOINT).hostname}`);
  assert.equal(headers.get('host'), url.hostname);
  assert.equal(url.search, '');
}

function sandbox(t) {
  mkdirSync(work, { recursive: true });
  const canonicalWork = realpathSync(work), directory = realpathSync(mkdtempSync(path.join(canonicalWork, 'avatar-api-test-')));
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, credentials); delete process.env.MOTION_OSS_SECURITY_TOKEN;
  const videoPath = path.join(directory, 'person.mp4'), audioPath = path.join(directory, 'speech.wav'), output = path.join(directory, 'avatar.mp4');
  writeFileSync(videoPath, mp4); writeFileSync(audioPath, Buffer.from('RIFFmock-audio-data'));
  const calls = [], puts = []; let clock = baseTime;
  let handler = () => { throw new Error('Unexpected mock request; real network is disabled.'); };
  const internal = {
    now: () => clock,
    wait: async (ms, signal) => { signal.throwIfAborted(); clock += ms; },
    timeoutMs: 1000, requestTimeoutMs: 1000, pollMs: 10,
    put: async (url, headers, source, signal) => { signal.throwIfAborted(); puts.push({ url: String(url), headers, source }); },
    fetch: async (input, options = {}) => {
      const call = { url: String(input), method: options.method ?? 'GET', headers: new Headers(options.headers), body: options.body ? JSON.parse(options.body) : undefined, redirect: options.redirect, signal: options.signal };
      calls.push(call); return handler(call);
    },
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const canonical = realpathSync(directory);
    assert.equal(canonical, directory); assert.equal(path.dirname(canonical), canonicalWork);
    assert.ok(path.basename(canonical).startsWith('avatar-api-test-'));
    rmSync(canonical, { recursive: true, force: false });
  });
  return {
    directory, videoPath, audioPath, output, calls, puts, internal,
    run: options => generateAvatar({ directory, videoPath, audioPath, output, ...options, internal: { ...internal, ...options?.internal } }),
    mock(next) { calls.length = 0; puts.length = 0; handler = next; },
    advance(ms) { clock += ms; },
    record() { return JSON.parse(readFileSync(path.join(directory, 'avatar-request.json'), 'utf8')); },
  };
}
function completed(call) {
  if (call.method === 'POST') return reply({ video_task_id: 'task / mock', bill_id: 'bill-mock' });
  if (call.url.startsWith(apiRoot)) return reply({ state: 20, videoUrl: resultUrl });
  assert.equal(call.url, resultUrl); return movie();
}
function noPersistedSecrets(s) {
  const record = readFileSync(path.join(s.directory, 'avatar-request.json'), 'utf8');
  for (const secret of [...Object.values(credentials), process.env.MOTION_OSS_SECURITY_TOKEN].filter(Boolean)) assert.ok(!record.includes(secret));
  assert.ok(!record.includes('q-signature')); assert.ok(!record.includes('video_url')); assert.ok(!record.includes(resultUrl));
  assert.ok(!readdirSync(s.directory).some(name => name.endsWith('.tmp') || name.endsWith('.pending') || name.endsWith('.lock')));
}

test('configuration fails closed with server env names and HTTPS regional COS endpoints', async t => {
  const s = sandbox(t);
  assert.equal(configurationError(), undefined); assert.equal(avatarConfigured(), true);
  delete process.env.YIDEVS_API_KEY;
  assert.match(configurationError(), /YIDEVS_API_KEY/); assert.equal(avatarConfigured(), false);
  await assert.rejects(s.run(), errorCode('AVATAR_CONFIG'));
  process.env.YIDEVS_API_KEY = credentials.YIDEVS_API_KEY;
  for (const invalid of ['http://cos.ap-guangzhou.myqcloud.com', 'https://other.example', 'https://user:pass@cos.ap-guangzhou.myqcloud.com', 'https://cos.ap-guangzhou.myqcloud.com/path', 'https://cos.ap-guangzhou.myqcloud.com?secret=mock', 'https://oss-cn-shanghai.aliyuncs.com']) {
    process.env.MOTION_OSS_ENDPOINT = invalid;
    assert.match(configurationError(), /MOTION_OSS_ENDPOINT/);
    await assert.rejects(s.run(), errorCode('AVATAR_CONFIG'));
  }
  assert.equal(s.calls.length + s.puts.length, 0);
});

test('COS endpoint and full BucketName-APPID validation excludes alternate origins and enforces DNS length', () => {
  const endpoint = 'cos.ap-guangzhou.myqcloud.com';
  assert.equal(validateCosEndpoint(`https://${endpoint}`), endpoint);
  assert.equal(validateCosEndpoint(` https://${endpoint}/ `), endpoint);
  assert.equal(validateCosBucket('avatar-mock-bucket-1250000000'), 'avatar-mock-bucket-1250000000');
  assert.equal(validateCosBucket('1-newproject-1250000000'), '1-newproject-1250000000');
  for (const invalid of ['https://cos.ap-guangzhou.myqcloud.com:443', 'https://cos.ap-guangzhou.myqcloud.com#fragment', 'https://cos.ap-guangzhou.myqcloud.com?query', 'https://cos.ap-guangzhou.myqcloud.com/objects', 'https://avatar-1250000000.cos.ap-guangzhou.myqcloud.com', 'https://cos.ap-guangzhou.myqcloud.com.attacker.example', 'https://user:pass@cos.ap-guangzhou.myqcloud.com']) assert.throws(() => validateCosEndpoint(invalid), errorCode('AVATAR_CONFIG'));
  for (const invalid of ['', 'bucket-without-appid', 'bucket-appid', 'Upper-1250000000', 'with_under-1250000000', '-bucket-1250000000', 'bucket--1250000000', 'bucket-1250000000\r\n', 'a'.repeat(63) + '-1']) assert.throws(() => validateCosBucket(invalid), errorCode('AVATAR_CONFIG'));
  assert.equal(validateCosBucket(`${'a'.repeat(50)}-123456789012`), `${'a'.repeat(50)}-123456789012`);
  assert.throws(() => validateCosBucket(`${'a'.repeat(51)}-1`), errorCode('AVATAR_CONFIG'));
  assert.throws(() => validateCosBucket(`${'a'.repeat(50)}-1234567890123`), errorCode('AVATAR_CONFIG'));
});

test('private COS uploads, signed GET sources, exact create protocol, saved IDs, and unauthenticated MP4 download', async t => {
  const s = sandbox(t), stages = []; let awaited = false;
  s.mock(call => {
    if (call.method === 'POST') {
      assert.ok(awaited); assert.equal(call.url, `${apiRoot}/direct`);
      assert.equal(call.headers.get('Authorization'), `Bearer ${credentials.YIDEVS_API_KEY}`);
      assert.equal(call.headers.get('Content-Type'), 'application/json'); assert.equal(call.redirect, 'error');
      assert.deepEqual(Object.keys(call.body).sort(), ['audio_url', 'video_url']);
      const record = s.record(); assert.equal(record.status, 'submission-uncertain'); assert.ok(record.requestId); assert.equal(record.taskId, undefined);
      for (const [key, source] of [['video_url', record.video], ['audio_url', record.audio]]) {
        cosGet(call.body[key], source.object);
      }
      return reply({ video_task_id: 'task / mock', bill_id: 'bill-mock' });
    }
    if (call.url.startsWith(apiRoot)) {
      assert.equal(call.url, `${apiRoot}/task?task_id=task%20%2F%20mock`);
      assert.equal(s.record().taskId, 'task / mock'); assert.equal(s.record().status, 'processing');
      return reply({ state: 20, videoUrl: resultUrl });
    }
    assert.equal(call.headers.get('Authorization'), null); assert.equal(call.redirect, 'manual'); return movie();
  });
  const result = await s.run({ onStage: async stage => { await Promise.resolve(); stages.push(stage); awaited = true; } });
  assert.deepEqual(result, { videoPath: s.output, taskId: 'task / mock' });
  assert.deepEqual(readFileSync(s.output), mp4); assert.equal(s.puts.length, 2);
  for (const upload of s.puts) {
    const source = upload.source === s.videoPath ? s.record().video : s.record().audio;
    cosPut(upload, source);
  }
  assert.equal(s.record().status, 'downloaded'); assert.equal(s.record().billId, 'bill-mock'); assert.equal(stages.at(-1), '数字人成片已就绪');
  noPersistedSecrets(s);
});

test('STS uploads and signed reads include the signed COS security-token without persisting it', async t => {
  const s = sandbox(t), token = 'avatar-mock-security-token/+=';
  process.env.MOTION_OSS_SECURITY_TOKEN = token;
  s.mock(call => {
    if (call.method === 'POST') {
      for (const [key, source] of [['video_url', s.record().video], ['audio_url', s.record().audio]]) {
        cosGet(call.body[key], source.object, credentials, token);
      }
    }
    return completed(call);
  });
  await s.run();
  for (const upload of s.puts) {
    const source = upload.source === s.videoPath ? s.record().video : s.record().audio;
    cosPut(upload, source, credentials, token);
  }
  noPersistedSecrets(s);
});

test('unknown processing states poll and a saved task ID resumes using GET only', async t => {
  const s = sandbox(t); let polls = 0;
  s.mock(call => call.method === 'POST' ? reply({ video_task_id: 'resume-mock' }) : ++polls === 1 ? reply({ state: -777 }) : new Response('sensitive provider error', { status: 503 }));
  await assert.rejects(s.run(), errorCode('AVATAR_HTTP'));
  assert.equal(polls, 2); assert.equal(s.record().taskId, 'resume-mock');
  s.mock(call => call.url.startsWith(apiRoot) ? reply({ state: 20, videoUrl: resultUrl }) : movie());
  await s.run();
  assert.deepEqual(s.calls.map(call => call.method), ['GET', 'GET']); assert.equal(s.puts.length, 0); noPersistedSecrets(s);
});

test('HTTP, provider, malformed, oversized, and missing-ID creation responses stay uncertain and refuse resubmission', async t => {
  for (const [name, handler, code] of [
    ['http', () => new Response(credentials.YIDEVS_API_KEY, { status: 502 }), 'AVATAR_HTTP'],
    ['provider', () => Response.json({ code: 401, msg: credentials.YIDEVS_API_KEY }), 'AVATAR_PROVIDER'],
    ['json', () => new Response('invalid ' + credentials.YIDEVS_API_KEY), 'AVATAR_RESPONSE'],
    ['declared-large', () => new Response('{}', { headers: { 'Content-Length': String(1024 ** 2 + 1) } }), 'AVATAR_RESPONSE'],
    ['stream-large', () => new Response(Buffer.alloc(1024 ** 2 + 1)), 'AVATAR_RESPONSE'],
    ['missing-id', () => reply({ bill_id: 'mock-without-task' }), 'AVATAR_UNCERTAIN'],
    ['secret-id', () => reply({ video_task_id: credentials.YIDEVS_API_KEY }), 'AVATAR_UNCERTAIN'],
  ]) await t.test(name, async t => {
    const s = sandbox(t); s.mock(handler);
    await assert.rejects(s.run(), errorCode(code)); assert.equal(s.record().status, 'submission-uncertain');
    assert.ok(s.record().requestId); assert.equal(s.record().taskId, undefined);
    s.mock(() => { throw new Error('Must not submit again.'); });
    await assert.rejects(s.run(), errorCode('AVATAR_UNCERTAIN'));
    assert.equal(s.calls.length + s.puts.length, 0); noPersistedSecrets(s);
  });
});

test('request timeout during creation saves uncertainty and caller cancellation before work sends nothing', async t => {
  const s = sandbox(t), aborted = new AbortController(); aborted.abort();
  await assert.rejects(s.run({ signal: aborted.signal }), errorCode('AVATAR_CANCELLED'));
  assert.equal(s.calls.length + s.puts.length, 0);
  s.mock(call => new Promise((resolve, reject) => call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true })));
  const keepAlive = setInterval(() => {}, 20);
  try { await assert.rejects(s.run({ internal: { requestTimeoutMs: 10 } }), errorCode('AVATAR_TIMEOUT')); }
  finally { clearInterval(keepAlive); }
  assert.equal(s.record().status, 'submission-uncertain'); assert.equal(s.calls.filter(call => call.method === 'POST').length, 1);
  s.mock(completed); await assert.rejects(s.run(), errorCode('AVATAR_UNCERTAIN')); assert.equal(s.calls.length + s.puts.length, 0); noPersistedSecrets(s);
});

test('cancelled polling and downloads preserve the ID for restart and remove incomplete files', async t => {
  const s = sandbox(t), controller = new AbortController();
  s.mock(call => {
    if (call.method === 'POST') return reply({ video_task_id: 'cancel-mock' });
    controller.abort(); return reply({ state: 0 });
  });
  await assert.rejects(s.run({ signal: controller.signal }), errorCode('AVATAR_CANCELLED'));
  assert.equal(s.record().taskId, 'cancel-mock'); assert.equal(s.record().status, 'processing'); noPersistedSecrets(s);
  const downloadController = new AbortController();
  s.mock(call => call.url.startsWith(apiRoot) ? reply({ state: 20, videoUrl: resultUrl }) : new Response(new ReadableStream({
    pull(stream) { downloadController.abort(); stream.enqueue(mp4); stream.close(); },
  }, { highWaterMark: 0 })));
  await assert.rejects(s.run({ signal: downloadController.signal }), errorCode('AVATAR_CANCELLED'));
  assert.equal(s.record().taskId, 'cancel-mock'); assert.equal(s.record().status, 'downloading'); assert.equal(existsSync(s.output), false); noPersistedSecrets(s);
  s.mock(call => call.url.startsWith(apiRoot) ? reply({ state: 20, videoUrl: resultUrl }) : movie());
  await s.run(); assert.equal(s.puts.length, 0); assert.ok(s.calls.every(call => call.method === 'GET')); noPersistedSecrets(s);
});

test('polling total timeout and provider error retain saved IDs without interpreting unknown states as failures', async t => {
  const s = sandbox(t);
  s.mock(call => call.method === 'POST' ? reply({ video_task_id: 'poll-mock' }) : reply({ state: 999 }));
  await assert.rejects(s.run({ internal: { timeoutMs: 30 } }), errorCode('AVATAR_TIMEOUT'));
  assert.equal(s.record().taskId, 'poll-mock'); assert.equal(s.calls.filter(call => call.method === 'POST').length, 1);
  s.mock(() => Response.json({ code: 400, data: { state: 20 }, msg: credentials.YIDEVS_API_KEY }));
  await assert.rejects(s.run(), errorCode('AVATAR_PROVIDER'));
  assert.equal(s.puts.length, 0); assert.equal(s.calls.length, 1); noPersistedSecrets(s);
});

test('HTTPS-only result and redirect policy, size bounds, MP4 signature, and no-overwrite are enforced', async t => {
  for (const [name, result, body, code] of [
    ['http-result', 'http://result.example/file.mp4', movie, 'AVATAR_DOWNLOAD'],
    ['credentials-result', 'https://user:pass@result.example/file.mp4', movie, 'AVATAR_DOWNLOAD'],
    ['http-redirect', resultUrl, () => new Response(null, { status: 302, headers: { Location: 'http://result.example/insecure' } }), 'AVATAR_DOWNLOAD'],
    ['redirect-limit', resultUrl, () => new Response(null, { status: 307, headers: { Location: '/another.mp4' } }), 'AVATAR_DOWNLOAD'],
    ['large-download', resultUrl, () => new Response(mp4, { headers: { 'Content-Length': String(1024 ** 3 + 1) } }), 'AVATAR_DOWNLOAD'],
    ['non-mp4', resultUrl, () => new Response(Buffer.alloc(32)), 'AVATAR_DOWNLOAD'],
    ['existing-race', resultUrl, s => { writeFileSync(s.output, 'existing owner'); return movie(); }, 'AVATAR_INPUT'],
  ]) await t.test(name, async t => {
    const s = sandbox(t);
    s.mock(call => call.method === 'POST' ? reply({ video_task_id: 'download-mock' }) : call.url.startsWith(apiRoot) ? reply({ state: 20, videoUrl: result }) : body(s));
    await assert.rejects(s.run(), errorCode(code));
    assert.equal(s.record().taskId, 'download-mock');
    for (const call of s.calls.filter(call => !call.url.startsWith(apiRoot))) { assert.equal(call.headers.get('Authorization'), null); assert.equal(call.redirect, 'manual'); }
    if (name === 'existing-race') assert.equal(readFileSync(s.output, 'utf8'), 'existing owner'); else assert.equal(existsSync(s.output), false);
    noPersistedSecrets(s);
  });
});

test('same-directory concurrency refuses a second create and async stage callbacks complete in order', async t => {
  const s = sandbox(t); s.mock(completed);
  let entered; const started = new Promise(resolve => { entered = resolve; });
  let unblock; const pause = new Promise(resolve => { unblock = resolve; });
  const first = s.run({ onStage: async stage => { if (stage === '正在提交数字人合成') { entered(); await pause; } } });
  await started;
  await assert.rejects(s.run(), errorCode('AVATAR_BUSY'));
  assert.equal(s.record().status, 'submission-uncertain'); assert.equal(s.calls.length, 0);
  unblock(); await first;
  assert.equal(s.calls.filter(call => call.method === 'POST').length, 1); noPersistedSecrets(s);
});

test('two independent processes refuse an existing stale lock without deleting it or making paid requests', async t => {
  const s = sandbox(t), filename = path.join(s.directory, 'avatar-request.lock');
  const staleLock = JSON.stringify({ pid: 2147483647, owner: 'mock-old-lock-owner' });
  writeFileSync(filename, staleLock);
  const script = `
    import { generateAvatar } from ${JSON.stringify(new URL('./lib/avatar.js', import.meta.url).href)};
    let uploads = 0, paid = 0;
    try {
      await generateAvatar({ ...JSON.parse(process.argv[1]), internal: {
        put: async () => { uploads++; throw new Error('Unexpected upload'); },
        fetch: async (input, options) => { if (options.method === 'POST') paid++; throw new Error('Unexpected request'); },
      } });
      process.stdout.write(JSON.stringify({ error: null, uploads, paid }));
    } catch (error) { process.stdout.write(JSON.stringify({ error: error.code, uploads, paid })); }
  `;
  const options = JSON.stringify({ directory: s.directory, videoPath: s.videoPath, audioPath: s.audioPath, output: s.output });
  const runChild = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script, options], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { errors += data; });
    child.once('error', reject);
    child.once('close', code => { if (code !== 0) reject(new Error(`Mock worker exited ${code}: ${errors}`)); else resolve(JSON.parse(output)); });
  });
  const results = await Promise.all([runChild(), runChild()]);
  for (const result of results) assert.deepEqual(result, { error: 'AVATAR_BUSY', uploads: 0, paid: 0 });
  assert.equal(readFileSync(filename, 'utf8'), staleLock);
  await assert.rejects(s.run(), error => { errorCode('AVATAR_BUSY')(error); assert.match(error.message, /手动移除 avatar-request.lock/); return true; });
  assert.equal(readFileSync(filename, 'utf8'), staleLock); assert.equal(existsSync(path.join(s.directory, 'avatar-request.json')), false);
});

test('completed local output is reused and a crash after output installation recovers without network', async t => {
  const s = sandbox(t); s.mock(completed); await s.run();
  const record = s.record(); record.status = 'downloading';
  writeFileSync(path.join(s.directory, 'avatar-request.json'), JSON.stringify(record));
  s.mock(() => { throw new Error('Completed file requires no request.'); });
  const result = await s.run();
  assert.equal(result.videoPath, s.output); assert.equal(s.record().status, 'downloaded'); assert.equal(s.calls.length + s.puts.length, 0); noPersistedSecrets(s);
});

test('unsupported inputs and an existing output fail before uploads or paid creation', async t => {
  const s = sandbox(t);
  await assert.rejects(s.run({ videoPath: s.audioPath }), errorCode('AVATAR_INPUT'));
  writeFileSync(s.output, 'already-exists');
  await assert.rejects(s.run(), errorCode('AVATAR_INPUT'));
  assert.equal(s.calls.length + s.puts.length, 0); assert.equal(readFileSync(s.output, 'utf8'), 'already-exists');
});

test('private media helper needs COS only and returns an in-memory three-hour signed URL with private PUT signing', async t => {
  const s = sandbox(t), objectKey = 'agent-motion/voice/mock-request/sample.wav';
  delete process.env.YIDEVS_API_KEY;
  assert.equal(avatarConfigured(), false);
  const before = readdirSync(s.directory).sort();
  const url = new URL(await uploadPrivateMedia({ filePath: s.audioPath, objectKey, contentType: 'audio/wav', internal: s.internal }));
  cosGet(url, objectKey);
  assert.equal(s.calls.length, 0); assert.equal(s.puts.length, 1);
  const upload = s.puts[0];
  cosPut(upload, { object: objectKey, contentType: 'audio/wav', bytes: readFileSync(s.audioPath).length });
  assert.equal(new URLSearchParams(upload.headers.Authorization).get('q-signature'), 'f62533ab38471f135c0402080dbbd9a93cf78b2d');
  assert.equal(url.searchParams.get('q-signature'), '0ba7d1893e2961c482888fbbbd251ba7f53b479c');
  assert.deepEqual(readdirSync(s.directory).sort(), before); assert.equal(existsSync(path.join(s.directory, 'avatar-request.json')), false);
});

test('private media helper preserves STS signing and refuses invalid COS paths or MIME headers', async t => {
  const s = sandbox(t), token = 'avatar-mock-helper-sts/+=';
  process.env.MOTION_OSS_SECURITY_TOKEN = token;
  const objectKey = 'agent-motion/voice/mock-sts/sample.wav';
  const url = new URL(await uploadPrivateMedia({ filePath: s.audioPath, objectKey, contentType: 'audio/wav', internal: s.internal }));
  cosGet(url, objectKey, credentials, token);
  cosPut(s.puts[0], { object: objectKey, contentType: 'audio/wav', bytes: readFileSync(s.audioPath).length }, credentials, token);
  assert.equal(new URLSearchParams(s.puts[0].headers.Authorization).get('q-signature'), '1e1ecae0b32229d7dc8132041f2e3e52631cad83');
  assert.equal(url.searchParams.get('q-signature'), '02905bffce20780da5e834495fb64a3e17ccb761');
  s.puts.length = 0;
  for (const invalid of ['', '/sample.wav', 'voice/../sample.wav', 'voice/./sample.wav', 'voice//sample.wav', 'voice/sample.wav?mock=query', 'voice/%2e/sample.wav', 'voice/sample.wav#fragment', 'voice\\sample.wav', 'voice/\u0000sample.wav', 'voice/\ud800sample.wav', 'a'.repeat(1025)]) {
    await assert.rejects(uploadPrivateMedia({ filePath: s.audioPath, objectKey: invalid, contentType: 'audio/wav', internal: s.internal }), errorCode('AVATAR_INPUT'));
  }
  await assert.rejects(uploadPrivateMedia({ filePath: s.audioPath, objectKey, contentType: 'audio/wav\r\nAuthorization: injected', internal: s.internal }), errorCode('AVATAR_INPUT'));
  assert.equal(s.puts.length, 0);
});

test('official SDK fixed V5 vectors cover decoded Unicode paths, RFC 3986 punctuation, sorted headers, and signed STS query values', async t => {
  const s = sandbox(t), token = "avatar-mock-helper-sts/+=!()*'", objectKey = "agent-motion/声音 空间/!()*'é.wav";
  process.env.MOTION_OSS_SECURITY_TOKEN = token;
  const before = readdirSync(s.directory).sort();
  const url = new URL(await uploadPrivateMedia({ filePath: s.audioPath, objectKey, contentType: 'audio/wav', internal: s.internal }));
  cosGet(url, objectKey, credentials, token);
  cosPut(s.puts[0], { object: objectKey, contentType: 'audio/wav', bytes: 19 }, credentials, token);
  const pathname = '/agent-motion/%E5%A3%B0%E9%9F%B3%20%E7%A9%BA%E9%97%B4/%21%28%29%2A%27%C3%A9.wav';
  assert.equal(url.pathname, pathname); assert.equal(new URL(s.puts[0].url).pathname, pathname);
  assert.equal(new URLSearchParams(s.puts[0].headers.Authorization).get('q-signature'), '36b6d9c3d5e2145ebe208968c261098ed96adf6e');
  assert.equal(url.searchParams.get('q-signature'), '001dcbc0a1fdb728fb926470fbfb9a8968f898d0');
  assert.ok(url.href.includes('x-cos-security-token=avatar-mock-helper-sts%2F%2B%3D%21%28%29%2A%27'));
  assert.deepEqual(readdirSync(s.directory).sort(), before); assert.equal(s.calls.length, 0);
});

test('private media helper handles caller abort, bounded request timeout, and redacts transport failures', async t => {
  const s = sandbox(t), options = { filePath: s.audioPath, objectKey: 'agent-motion/voice/mock-cancel/sample.wav', contentType: 'audio/wav', internal: s.internal };
  const early = new AbortController(); early.abort();
  await assert.rejects(uploadPrivateMedia({ ...options, signal: early.signal }), errorCode('AVATAR_CANCELLED')); assert.equal(s.puts.length, 0);
  const during = new AbortController();
  await assert.rejects(uploadPrivateMedia({ ...options, signal: during.signal, internal: { ...s.internal, put: async () => { during.abort(); } } }), errorCode('AVATAR_CANCELLED'));
  const keepAlive = setInterval(() => {}, 20);
  try {
    await assert.rejects(uploadPrivateMedia({ ...options, internal: { ...s.internal, requestTimeoutMs: 10, put: async (_url, _headers, _file, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) } }), errorCode('AVATAR_TIMEOUT'));
  } finally { clearInterval(keepAlive); }
  await assert.rejects(uploadPrivateMedia({ ...options, internal: { ...s.internal, put: async () => { throw new Error('Transport echoed ' + credentials.MOTION_OSS_ACCESS_KEY_SECRET); } } }), errorCode('AVATAR_STORAGE'));
  assert.equal(existsSync(path.join(s.directory, 'avatar-request.json')), false);
});

test('Harness configuration preflight uses the supplied credential map and keeps missing settings missing', async t => {
  sandbox(t);
  const mapped = { ...credentials, YIDEVS_API_KEY: 'avatar-settings-mock-api-key' };
  assert.equal(configurationError(mapped), undefined); assert.equal(avatarConfigured(mapped), true);
  assert.match(configurationError({}), /Harness 插件设置.*YIDEVS_API_KEY/); assert.equal(avatarConfigured({}), false);
  const missingCos = { ...mapped }; delete missingCos.MOTION_OSS_ACCESS_KEY_SECRET;
  assert.match(configurationError(missingCos), /Harness 插件设置.*COS SecretKey/); assert.equal(avatarConfigured(missingCos), false);
  assert.equal(configurationError(), undefined);
  assert.equal(process.env.YIDEVS_API_KEY, credentials.YIDEVS_API_KEY);
});

test('Harness avatar submission signs uploads and authenticates with the supplied map without persisting secrets', async t => {
  const s = sandbox(t), mapped = {
    YIDEVS_API_KEY: 'avatar-settings-mock-api-key', MOTION_OSS_ENDPOINT: 'https://cos.ap-beijing.myqcloud.com',
    MOTION_OSS_BUCKET: 'avatar-settings-1250000000', MOTION_OSS_ACCESS_KEY_ID: 'avatar-settings-mock-access-id',
    MOTION_OSS_ACCESS_KEY_SECRET: 'avatar-settings-mock-access-secret', MOTION_OSS_SECURITY_TOKEN: 'avatar-settings-mock-sts/+=',
  };
  s.mock(call => {
    if (call.method === 'POST') {
      assert.equal(call.headers.get('Authorization'), `Bearer ${mapped.YIDEVS_API_KEY}`);
      for (const [key, source] of [['video_url', s.record().video], ['audio_url', s.record().audio]]) {
        cosGet(call.body[key], source.object, mapped);
      }
    } else if (call.url.startsWith(apiRoot)) assert.equal(call.headers.get('Authorization'), `Bearer ${mapped.YIDEVS_API_KEY}`);
    else assert.equal(call.headers.get('Authorization'), null);
    return completed(call);
  });
  await s.run({ credentials: mapped });
  for (const upload of s.puts) {
    const source = upload.source === s.videoPath ? s.record().video : s.record().audio;
    cosPut(upload, source, mapped);
  }
  const record = readFileSync(path.join(s.directory, 'avatar-request.json'), 'utf8');
  for (const value of Object.values(mapped)) assert.ok(!record.includes(value));
  assert.equal(process.env.YIDEVS_API_KEY, credentials.YIDEVS_API_KEY); assert.equal(process.env.MOTION_OSS_ACCESS_KEY_SECRET, credentials.MOTION_OSS_ACCESS_KEY_SECRET);
  noPersistedSecrets(s);
});

test('Harness private-media upload uses its supplied COS map without requiring YIDEVS or ambient STS', async t => {
  const s = sandbox(t), mapped = {
    MOTION_OSS_ENDPOINT: 'https://cos.ap-beijing.myqcloud.com', MOTION_OSS_BUCKET: 'avatar-helper-1250000000',
    MOTION_OSS_ACCESS_KEY_ID: 'avatar-helper-settings-access-id', MOTION_OSS_ACCESS_KEY_SECRET: 'avatar-helper-settings-access-secret',
  };
  process.env.MOTION_OSS_SECURITY_TOKEN = 'avatar-ambient-mock-sts-must-not-be-used';
  const objectKey = 'agent-motion/voice/settings-sample.wav';
  const url = new URL(await uploadPrivateMedia({ filePath: s.audioPath, objectKey, contentType: 'audio/wav', credentials: mapped, internal: s.internal }));
  cosGet(url, objectKey, mapped);
  const upload = s.puts[0]; cosPut(upload, { object: objectKey, contentType: 'audio/wav', bytes: readFileSync(s.audioPath).length }, mapped);
  assert.equal(new URLSearchParams(upload.headers.Authorization).get('q-signature'), '5b9cd0112002ce61901cdcd0f4172974cf7d595b');
  assert.equal(url.searchParams.get('q-signature'), '4a896e4a60f853aae6546544e8bc176517730f16');
  assert.equal(existsSync(path.join(s.directory, 'avatar-request.json')), false); assert.equal(s.calls.length, 0);
});

test('empty Harness credential maps never fall back to otherwise valid server environment for generation or upload', async t => {
  const s = sandbox(t);
  await assert.rejects(s.run({ credentials: {} }), error => { errorCode('AVATAR_CONFIG')(error); assert.match(error.message, /Harness 插件设置/); return true; });
  await assert.rejects(uploadPrivateMedia({ filePath: s.audioPath, objectKey: 'agent-motion/voice/empty-map.wav', contentType: 'audio/wav', credentials: {}, internal: s.internal }), error => { errorCode('AVATAR_CONFIG')(error); assert.match(error.message, /Harness 插件设置/); return true; });
  assert.equal(s.calls.length + s.puts.length, 0); assert.equal(existsSync(path.join(s.directory, 'avatar-request.json')), false);
  assert.equal(process.env.YIDEVS_API_KEY, credentials.YIDEVS_API_KEY);
});

test('settings SecretId rejects authorization and query delimiters before upload or generation', async t => {
  const s = sandbox(t);
  for (const value of ['mock-id&injected=query', 'mock-id=injected', 'mock id']) {
    const mapped = { ...credentials, MOTION_OSS_ACCESS_KEY_ID: value };
    const invalid = error => {
      errorCode('AVATAR_CONFIG')(error); assert.match(error.message, /Harness 插件设置.*COS SecretId/);
      assert.ok(!error.message.includes(value)); return true;
    };
    await assert.rejects(uploadPrivateMedia({ filePath: s.audioPath, objectKey: 'agent-motion/voice/invalid-id.wav', contentType: 'audio/wav', credentials: mapped, internal: s.internal }), invalid);
    await assert.rejects(s.run({ credentials: mapped }), invalid);
  }
  assert.equal(s.puts.length, 0); assert.equal(s.calls.length, 0);
  assert.equal(existsSync(path.join(s.directory, 'avatar-request.json')), false);
});
