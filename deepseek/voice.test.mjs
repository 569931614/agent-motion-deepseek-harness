import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { WebSocketServer } from 'ws';
import { synthesizeVoice } from './lib/voice.js';

const work = fileURLToPath(new URL('../work/', import.meta.url));
const testKey = 'mock-beijing-key-never-a-real-credential';
const voice = 'cosyvoice-v3.5-plus-myvoice-mock';
const pcm = Buffer.from([0, 0, 50, 0, 206, 255, 0, 0]);
const deferred = () => { let resolve; const promise = new Promise(next => { resolve = next; }); return { promise, resolve }; };
const event = (socket, taskId, type, fields = {}) => socket.send(JSON.stringify({ header: { task_id: taskId, event: type, ...fields }, payload: {} }));

async function sandbox(t, onMessage, onHttp, options = {}) {
  const workspace = options.externalDirectory ? tmpdir() : work;
  const forceHandshakeTimeout = options.forceHandshakeTimeout === true;
  mkdirSync(workspace, { recursive: true });
  const canonicalWork = realpathSync(workspace);
  const directory = realpathSync(mkdtempSync(path.join(canonicalWork, 'voice-api-test-')));
  const originalKey = process.env.DASHSCOPE_API_KEY;
  const originalRequest = https.request;
  const requests = [], messages = [], sockets = [], upgradeSockets = [];
  process.env.DASHSCOPE_API_KEY = testKey;
  const server = http.createServer((request, response) => {
    if (onHttp) onHttp(request, response);
    else { response.writeHead(404); response.end(); }
  });
  const websocketServer = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    upgradeSockets.push(socket);
    if (onHttp) { onHttp(request, socket); return; }
    assert.equal(request.url, '/api-ws/v1/inference');
    assert.equal(request.headers.authorization, `Bearer ${options.expectedKey ?? testKey}`);
    websocketServer.handleUpgrade(request, socket, head, ws => websocketServer.emit('connection', ws, request));
  });
  websocketServer.on('connection', socket => {
    sockets.push(socket);
    socket.on('error', () => {});
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      messages.push(message);
      onMessage?.(message, socket);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // Redirect only the official HTTPS handshake to this local mock. Unknown
  // requests throw, so no test can contact a provider or charge an account.
  https.request = (options, callback) => {
    assert.equal(options.hostname ?? options.host, 'dashscope.aliyuncs.com');
    assert.equal(options.path, '/api-ws/v1/inference');
    requests.push({ hostname: options.hostname ?? options.host, path: options.path });
    assert.equal(options.timeout, 30000);
    assert.equal(options.followRedirects, false);
    const request = http.request({ ...options, protocol: 'http:', createConnection: undefined, agent: undefined, defaultPort: 80, hostname: '127.0.0.1', host: '127.0.0.1', port: server.address().port }, callback);
    if (forceHandshakeTimeout) setImmediate(() => request.emit('timeout'));
    return request;
  };
  t.after(async () => {
    https.request = originalRequest;
    if (originalKey === undefined) delete process.env.DASHSCOPE_API_KEY;
    else process.env.DASHSCOPE_API_KEY = originalKey;
    for (const socket of sockets) socket.terminate();
    for (const socket of upgradeSockets) socket.destroy();
    await new Promise(resolve => websocketServer.close(resolve));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const canonical = realpathSync(directory);
    assert.equal(canonical, directory);
    assert.equal(path.dirname(canonical), canonicalWork);
    assert.ok(path.basename(canonical).startsWith('voice-api-test-'));
    rmSync(canonical, { recursive: true, force: false });
  });
  return { directory, requests, messages, output: name => path.join(directory, `${name}.wav`) };
}

function noTemporary(s) { assert.ok(readdirSync(s.directory).every(name => !name.startsWith('.voice-'))); }
function wavData(filename) {
  const data = readFileSync(filename);
  assert.equal(data.toString('ascii', 0, 4), 'RIFF');
  assert.equal(data.readUInt32LE(4), data.length - 8);
  assert.equal(data.toString('ascii', 8, 12), 'WAVE');
  assert.equal(data.readUInt16LE(20), 1);
  assert.equal(data.readUInt16LE(22), 1);
  assert.equal(data.readUInt32LE(24), 24000);
  assert.equal(data.readUInt16LE(34), 16);
  assert.equal(data.toString('ascii', 36, 40), 'data');
  assert.equal(data.readUInt32LE(40), data.length - 44);
  return data.subarray(44);
}

test('Harness credentials authorize the voice socket without changing global environment or persisting secrets', { concurrency: false }, async t => {
  const settingsKey = 'settings-beijing-key-never-a-real-credential';
  const credentials = Object.freeze({ DASHSCOPE_API_KEY: settingsKey });
  const s = await sandbox(t, (message, socket) => {
    const { action, task_id } = message.header;
    if (action === 'run-task') event(socket, task_id, 'task-started');
    if (action === 'finish-task') { socket.send(pcm); event(socket, task_id, 'task-finished'); }
  }, undefined, { expectedKey: settingsKey });
  const output = s.output('settings');
  assert.deepEqual(await synthesizeVoice({ directory: s.directory, text: '设置音色', voice, output, credentials }), { audioPath: output });
  assert.equal(process.env.DASHSCOPE_API_KEY, testKey);
  assert.equal(credentials.DASHSCOPE_API_KEY, settingsKey);
  assert.equal(s.requests.length, 1);
  for (const filename of readdirSync(s.directory)) assert.ok(!readFileSync(path.join(s.directory, filename)).includes(Buffer.from(settingsKey)));
  noTemporary(s);
});

test('empty, missing or invalid Harness credentials fail before connecting and never use environment keys', { concurrency: false }, async t => {
  const s = await sandbox(t);
  const options = { directory: s.directory, text: '原文', voice, output: s.output('missing-settings') };
  for (const credentials of [{}, { YIDEVS_API_KEY: 'other-service-mock' }, { DASHSCOPE_API_KEY: 'bad\nsettings-secret' }]) {
    await assert.rejects(synthesizeVoice({ ...options, credentials }), error => {
      assert.match(error.message, /Harness.*设置.*DASHSCOPE_API_KEY/);
      assert.ok(!error.message.includes('settings-secret'));
      return true;
    });
  }
  assert.equal(s.requests.length, 0); assert.equal(process.env.DASHSCOPE_API_KEY, testKey);
  assert.equal(readdirSync(s.directory).length, 0);
});

test('voice errors do not expose a Harness credential echoed by the provider', { concurrency: false }, async t => {
  const settingsKey = 'settings-provider-echo-key-never-real';
  const s = await sandbox(t, (message, socket) => {
    if (message.header.action === 'run-task') event(socket, message.header.task_id, 'task-failed', { error_code: settingsKey, error_message: settingsKey });
  }, undefined, { expectedKey: settingsKey });
  await assert.rejects(synthesizeVoice({ directory: s.directory, text: '原文', voice, output: s.output('settings-echo'), credentials: { DASHSCOPE_API_KEY: settingsKey } }), error => {
    assert.ok(!error.message.includes(settingsKey)); return true;
  });
  assert.equal(s.requests.length, 1); assert.equal(process.env.DASHSCOPE_API_KEY, testKey); noTemporary(s);
});

test('one paid task waits for persisted submission state, preserves Unicode text and publishes a correctly sized WAV', { concurrency: false }, async t => {
  const recording = deferred(), allowSubmission = deferred();
  let recorded = false;
  const s = await sandbox(t, (message, socket) => {
    const { action, task_id } = message.header;
    assert.equal(recorded, true);
    assert.equal(message.header.streaming, 'duplex');
    if (action === 'run-task') {
      assert.deepEqual(message.payload, {
        task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model: 'cosyvoice-v3.5-plus', input: {},
        parameters: { text_type: 'PlainText', voice, format: 'pcm', sample_rate: 24000, volume: 50, rate: 1.0, pitch: 1.0 },
      });
      event(socket, task_id, 'task-started');
    } else if (action === 'finish-task') {
      assert.deepEqual(message.payload, { input: {} });
      socket.send(pcm.subarray(0, 3));
      socket.send(pcm.subarray(3));
      event(socket, task_id, 'task-finished');
    }
  });
  const text = '  ' + '甲'.repeat(19997) + '😀' + '乙'.repeat(20000) + '\n最后。  ';
  const output = s.output('success');
  const result = synthesizeVoice({ directory: s.directory, text, voice, output, onSubmitted: async () => {
    recording.resolve(); await allowSubmission.promise;
    writeFileSync(path.join(s.directory, 'submission.json'), '{"status":"submission-uncertain"}');
    recorded = true;
  } });
  await recording.promise;
  assert.equal(s.messages.length, 0);
  allowSubmission.resolve();
  assert.deepEqual(await result, { audioPath: output });
  assert.equal(s.requests.length, 1);
  assert.equal(s.messages.filter(message => message.header.action === 'run-task').length, 1);
  const chunks = s.messages.filter(message => message.header.action === 'continue-task').map(message => message.payload.input.text);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every(chunk => [...chunk].length <= 20000));
  assert.equal(chunks.join(''), text);
  assert.equal(new Set(s.messages.map(message => message.header.task_id)).size, 1);
  assert.match(s.messages[0].header.task_id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.deepEqual(wavData(output), pcm);
  noTemporary(s);
  assert.ok(!readFileSync(output).includes(Buffer.from(testKey)));
});

test('invalid input and existing outputs fail before any handshake or submission callback', { concurrency: false }, async t => {
  const s = await sandbox(t);
  let callbacks = 0;
  const options = { directory: s.directory, text: '完整原文。', voice, output: s.output('preflight'), onSubmitted: () => { callbacks++; } };
  await assert.rejects(synthesizeVoice({ ...options, text: ' '.repeat(3) }), /nonempty/);
  await assert.rejects(synthesizeVoice({ ...options, text: '甲'.repeat(50001) }), /50000/);
  await assert.rejects(synthesizeVoice({ ...options, text: '\ud800' }), /Unicode/);
  await assert.rejects(synthesizeVoice({ ...options, voice: '' }), /custom voice/);
  await assert.rejects(synthesizeVoice({ ...options, voice: 'voice\nInjected' }), /custom voice/);
  await assert.rejects(synthesizeVoice({ ...options, output: path.join(s.directory, 'bad.mp3') }), /\.wav/);
  await assert.rejects(synthesizeVoice({ ...options, output: path.resolve(work, '../../../outside.wav') }), /inside|ENOENT/);
  process.env.DASHSCOPE_API_KEY = 'bad\nkey';
  await assert.rejects(synthesizeVoice(options), /Beijing/);
  process.env.DASHSCOPE_API_KEY = testKey;
  writeFileSync(options.output, 'existing audio');
  await assert.rejects(synthesizeVoice(options), /already exists/);
  assert.equal(readFileSync(options.output, 'utf8'), 'existing audio');
  assert.equal(callbacks, 0);
  assert.equal(s.requests.length, 0);
  noTemporary(s);
});

test('a trusted Studio task directory outside the installed plugin can receive audio', { concurrency: false }, async t => {
  const s = await sandbox(t, (message, socket) => {
    if (message.header.action === 'run-task') event(socket, message.header.task_id, 'task-started');
    if (message.header.action === 'finish-task') { socket.send(pcm); event(socket, message.header.task_id, 'task-finished'); }
  }, undefined, { externalDirectory: true });
  assert.ok(!s.directory.startsWith(realpathSync(work)));
  const output = s.output('hosted-studio');
  assert.deepEqual(await synthesizeVoice({ directory: s.directory, text: '原文', voice, output }), { audioPath: output });
  assert.deepEqual(wavData(output), pcm);
  noTemporary(s);
});

test('cancellation during submission persistence and callback failure prevent the charged run-task', { concurrency: false }, async t => {
  const s = await sandbox(t);
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  await assert.rejects(synthesizeVoice({ directory: s.directory, text: '原文', voice, output: s.output('pre-abort'), signal: alreadyAborted.signal }), /before submission/);
  assert.equal(s.requests.length, 0);
  const controller = new AbortController(), recording = deferred(), resume = deferred();
  const pending = synthesizeVoice({ directory: s.directory, text: '原文', voice, output: s.output('record-abort'), signal: controller.signal,
    onSubmitted: async () => { recording.resolve(); await resume.promise; } });
  await recording.promise;
  controller.abort();
  await assert.rejects(pending, /before submission/);
  resume.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.messages.length, 0);
  await assert.rejects(synthesizeVoice({ directory: s.directory, text: '原文', voice, output: s.output('record-failure'), onSubmitted: () => { throw new Error(testKey); } }), error => {
    assert.match(error.message, /could not be saved/); assert.ok(!error.message.includes(testKey)); return true;
  });
  assert.equal(s.messages.length, 0);
  noTemporary(s);
});

test('HTTP authentication and redirects stop without a paid task or credential-bearing error', { concurrency: false }, async t => {
  for (const status of [401, 302]) {
    await t.test(`HTTP ${status}`, async child => {
      const s = await sandbox(child, undefined, (_request, socket) => {
        socket.end(`HTTP/1.1 ${status} Mock\r\nLocation: https://untrusted.example/\r\nConnection: close\r\nContent-Length: ${testKey.length}\r\n\r\n${testKey}`);
      });
      let submitted = false;
      await assert.rejects(synthesizeVoice({ directory: s.directory, text: '原文', voice, output: s.output('http'), onSubmitted: () => { submitted = true; } }), error => {
        assert.match(error.message, new RegExp(`HTTP ${status}`)); assert.ok(!error.message.includes(testKey)); return true;
      });
      assert.equal(submitted, false);
      assert.equal(s.requests.length, 1);
      noTemporary(s);
    });
  }
});

test('provider failures and protocol errors are sanitized, clean partial audio and never retry', { concurrency: false }, async t => {
  const cases = [
    ['task-failed', (socket, id) => event(socket, id, 'task-failed', { error_code: 'InvalidParameter', error_message: testKey })],
    ['unknown-error-code', (socket, id) => event(socket, id, 'task-failed', { error_code: testKey, error_message: testKey })],
    ['invalid-json', socket => socket.send('{invalid json ' + testKey)],
    ['wrong-task', socket => event(socket, 'different-task', 'task-started')],
    ['early-audio', socket => socket.send(pcm)],
    ['early-finish', (socket, id) => event(socket, id, 'task-finished')],
  ];
  for (const [name, reply] of cases) {
    await t.test(name, async child => {
      const s = await sandbox(child, (message, socket) => {
        if (message.header.action === 'run-task') reply(socket, message.header.task_id);
      });
      await assert.rejects(synthesizeVoice({ directory: s.directory, text: '原文', voice, output: s.output('failed') }), error => {
        assert.ok(!error.message.includes(testKey)); return true;
      });
      assert.equal(s.requests.length, 1);
      assert.equal(s.messages.filter(message => message.header.action === 'run-task').length, 1);
      assert.equal(existsSync(s.output('failed')), false);
      noTemporary(s);
    });
  }
});

test('midstream disconnect and cancellation remove partial audio without reissuing a task', { concurrency: false }, async t => {
  for (const mode of ['disconnect', 'cancel']) {
    await t.test(mode, async child => {
      const controller = new AbortController();
      const s = await sandbox(child, (message, socket) => {
        if (message.header.action === 'run-task') event(socket, message.header.task_id, 'task-started');
        if (message.header.action === 'continue-task') {
          socket.send(pcm);
          if (mode === 'disconnect') socket.terminate();
          else controller.abort();
        }
      });
      await assert.rejects(synthesizeVoice({ directory: s.directory, text: '原文', voice, output: s.output('partial'), signal: controller.signal }), /disconnected|cancelled/);
      assert.equal(s.requests.length, 1);
      assert.equal(s.messages.filter(message => message.header.action === 'run-task').length, 1);
      assert.equal(existsSync(s.output('partial')), false);
      noTemporary(s);
    });
  }
});

test('empty and truncated PCM are rejected and existing audio wins a publication race', { concurrency: false }, async t => {
  for (const mode of ['empty', 'odd', 'output-race']) {
    await t.test(mode, async child => {
      let output;
      const s = await sandbox(child, (message, socket) => {
        if (message.header.action === 'run-task') event(socket, message.header.task_id, 'task-started');
        if (message.header.action === 'finish-task') {
          if (mode === 'odd') socket.send(Buffer.from([1]));
          if (mode === 'output-race') { socket.send(pcm); writeFileSync(output, 'preserve me'); }
          event(socket, message.header.task_id, 'task-finished');
        }
      });
      output = s.output('audio');
      await assert.rejects(synthesizeVoice({ directory: s.directory, text: '原文', voice, output }), /complete|could not be saved/);
      assert.equal(s.requests.length, 1);
      if (mode === 'output-race') assert.equal(readFileSync(output, 'utf8'), 'preserve me');
      else assert.equal(existsSync(output), false);
      noTemporary(s);
    });
  }
});

test('a local disk write failure cleans temporary audio and stops without retry', { concurrency: false }, async t => {
  const originalWrite = fs.writeSync;
  let writes = 0;
  fs.writeSync = (...args) => {
    if (++writes > 1) throw new Error(testKey);
    return originalWrite(...args);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.writeSync = originalWrite; syncBuiltinESMExports(); });
  const s = await sandbox(t, (message, socket) => {
    if (message.header.action === 'run-task') event(socket, message.header.task_id, 'task-started');
    if (message.header.action === 'finish-task') { socket.send(pcm); event(socket, message.header.task_id, 'task-finished'); }
  });
  await assert.rejects(synthesizeVoice({ directory: s.directory, text: '原文', voice, output: s.output('write-failure') }), error => {
    assert.match(error.message, /could not be written/); assert.ok(!error.message.includes(testKey)); return true;
  });
  assert.equal(s.requests.length, 1);
  assert.equal(existsSync(s.output('write-failure')), false);
  noTemporary(s);
});

test('the overall deadline and oversized response frames stop the single submitted task', { concurrency: false }, async t => {
  await t.test('handshake deadline', async child => {
    const s = await sandbox(child, undefined, undefined, { forceHandshakeTimeout: true });
    let submitted = false;
    await assert.rejects(synthesizeVoice({ directory: s.directory, text: '原文', voice, output: s.output('handshake-timeout'), onSubmitted: () => { submitted = true; } }), /handshake timed out/);
    assert.equal(submitted, false);
    assert.equal(s.requests.length, 1);
    assert.equal(existsSync(s.output('handshake-timeout')), false);
    noTemporary(s);
  });
  await t.test('overall deadline', async child => {
    const finishedInput = deferred();
    const s = await sandbox(child, (message, socket) => {
      if (message.header.action === 'run-task') event(socket, message.header.task_id, 'task-started');
      if (message.header.action === 'finish-task') finishedInput.resolve();
    });
    child.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = synthesizeVoice({ directory: s.directory, text: '原文', voice, output: s.output('timeout') });
    await finishedInput.promise;
    child.mock.timers.tick(30 * 60 * 1000 + 1);
    await assert.rejects(pending, /timed out/);
    assert.equal(s.requests.length, 1);
    assert.equal(existsSync(s.output('timeout')), false);
    noTemporary(s);
  });
  await t.test('bounded frame', async child => {
    const s = await sandbox(child, (message, socket) => {
      if (message.header.action === 'run-task') event(socket, message.header.task_id, 'task-started');
      if (message.header.action === 'finish-task') socket.send(Buffer.alloc(1024 * 1024 + 1));
    });
    await assert.rejects(synthesizeVoice({ directory: s.directory, text: '原文', voice, output: s.output('oversized') }), /connection failed/);
    assert.equal(s.requests.length, 1);
    assert.equal(existsSync(s.output('oversized')), false);
    noTemporary(s);
  });
});
