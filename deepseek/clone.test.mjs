import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cloneVideoVoice } from './lib/clone.js';

const model = 'cosyvoice-v3.5-plus';
const voiceId = 'cosyvoice-v3.5-plus-motion-mock';
const endpoint = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization';
const signedURL = 'https://clone-mock-bucket-1250000000.cos.ap-shanghai.myqcloud.com/sample.wav?q-sign-algorithm=sha1&q-signature=mock-signed-secret&x-cos-security-token=clone-mock-security-token';
const credentials = {
  DASHSCOPE_API_KEY: 'clone-mock-api-key-never-a-real-credential',
  YIDEVS_API_KEY: 'clone-mock-avatar-key',
  OPENAI_API_KEY: 'clone-mock-other-api-key',
  MOTION_OSS_ENDPOINT: 'https://cos.ap-shanghai.myqcloud.com',
  MOTION_OSS_BUCKET: 'clone-mock-bucket-1250000000',
  MOTION_OSS_ACCESS_KEY_ID: 'clone-mock-access-id',
  MOTION_OSS_ACCESS_KEY_SECRET: 'clone-mock-access-secret',
  MOTION_OSS_SECURITY_TOKEN: 'clone-mock-security-token',
};
const environmentKeys = [...Object.keys(credentials), 'FFMPEG_PATH', 'FFPROBE_PATH'];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const reply = output => Response.json({ output, request_id: 'mock-upstream-request' });
const goodSample = { streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '24000', channels: 1, bits_per_sample: 16 }], format: { duration: '20' } };
const argument = (args, ...names) => { const index = args.findIndex(item => names.includes(item)); return index === -1 ? undefined : args[index + 1]; };

function wav(seconds = 20) {
  const pcmBytes = Math.round(seconds * 24000) * 2;
  const data = Buffer.alloc(44 + pcmBytes);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(24000, 24); data.writeUInt32LE(48000, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(pcmBytes, 40);
  return data;
}

function sandbox(t) {
  const parent = realpathSync(tmpdir()), workspace = realpathSync(mkdtempSync(path.join(parent, 'motion-clone-test-')));
  const directory = path.join(workspace, 'inputs', 'studio', 'task');
  mkdirSync(directory, { recursive: true }); mkdirSync(path.join(workspace, 'scripts'));
  writeFileSync(path.join(workspace, 'scripts', 'bootstrap.mjs'), '// mocked bootstrap, never executed\n');
  const videoPath = path.join(directory, 'source.mp4');
  const video = Buffer.alloc(32); video.writeUInt32BE(32); video.write('ftyp', 4); video.write('isom', 8);
  writeFileSync(videoPath, video);
  const previous = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, credentials); delete process.env.FFMPEG_PATH; delete process.env.FFPROBE_PATH;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Unexpected network request; tests require the mock fetch seam.'); };
  const commands = [], uploads = [], calls = [], waits = [];
  let clock = 1700000000000;
  let handler = call => call.body.input.action === 'create_voice' ? reply({ voice_id: voiceId }) : reply({ voice_id: voiceId, status: 'OK', target_model: model });
  const defaultRun = async (command, args, options = {}) => {
    options.signal?.throwIfAborted(); commands.push({ command, args, options });
    if (args.includes('-version')) {
      if (path.isAbsolute(command) && !existsSync(command)) throw new Error('Mock managed tool does not exist.');
      return 'ffmpeg version mock\n';
    }
    if (path.basename(command).startsWith('ffprobe')) return JSON.stringify(args.at(-1) === videoPath ? { streams: [{ codec_type: 'video' }, { codec_type: 'audio' }], format: { duration: '20' } } : goodSample);
    if (path.basename(command).startsWith('ffmpeg')) { writeFileSync(args.at(-1), wav()); return ''; }
    throw new Error('Unexpected media command; no process may execute in this test.');
  };
  const internal = {
    run: defaultRun,
    upload: async options => { options.signal?.throwIfAborted(); uploads.push(options); return signedURL; },
    fetch: async (url, options = {}) => {
      const call = { url: String(url), method: options.method ?? 'GET', headers: new Headers(options.headers), redirect: options.redirect, body: options.body ? JSON.parse(options.body) : undefined, signal: options.signal };
      calls.push(call); return handler(call);
    },
    now: () => clock,
    wait: async (ms, signal) => { signal.throwIfAborted(); waits.push(ms); clock += ms; },
    timeoutMs: 1000, requestTimeoutMs: 1000, pollMs: 10,
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const canonical = realpathSync(workspace);
    assert.equal(canonical, workspace); assert.equal(path.dirname(canonical), parent);
    assert.ok(path.basename(canonical).startsWith('motion-clone-test-'));
    rmSync(canonical, { recursive: true, force: false });
  });
  const recordPath = path.join(directory, 'clone-request.json');
  return {
    workspace, directory, videoPath, commands, uploads, calls, waits, internal, defaultRun, recordPath,
    run: (options = {}) => cloneVideoVoice({ videoPath, directory, workspace, ...options, internal: { ...internal, ...options.internal } }),
    mock(next) { handler = next; },
    record: () => JSON.parse(readFileSync(recordPath, 'utf8')),
    seed(status, id) { const requestId = randomUUID(); writeFileSync(recordPath, JSON.stringify({ version: 1, requestId, status, videoPath, targetModel: model, sampleFilename: `clone-sample-${requestId}.wav`, ...(id ? { voiceId: id } : {}) })); },
    managed(name) { return path.join(workspace, '.runtime', 'media', ...(process.platform === 'win32' ? ['Library', 'bin', `${name}.exe`] : ['bin', name])); },
  };
}

function noSecrets(s, configured = credentials) {
  const contents = readFileSync(s.recordPath, 'utf8');
  for (const secret of [...Object.values(credentials), ...Object.values(configured), signedURL, 'mock-signed-secret']) assert.ok(!contents.includes(secret));
  assert.ok(!contents.includes('language_hints')); assert.ok(!contents.includes('Bearer'));
  assert.ok(!readdirSync(s.directory).some(name => name.endsWith('.lock') || name.endsWith('.tmp')));
}

function settingsCredentials() {
  return Object.freeze({
    DASHSCOPE_API_KEY: 'harness-mock-dashscope-settings-key',
    YIDEVS_API_KEY: 'harness-mock-avatar-settings-key',
    MOTION_OSS_ENDPOINT: 'https://cos.ap-beijing.myqcloud.com',
    MOTION_OSS_BUCKET: 'settings-mock-1250000000',
    MOTION_OSS_ACCESS_KEY_ID: 'harness-mock-settings-access-id',
    MOTION_OSS_ACCESS_KEY_SECRET: 'harness-mock-settings-access-secret',
    MOTION_OSS_SECURITY_TOKEN: 'harness-mock-settings-security-token',
  });
}

test('explicit Harness credentials override global cloud keys and reach upload through the same reference', async t => {
  const s = sandbox(t), configured = settingsCredentials();
  const environmentBefore = { ...process.env };
  s.mock(call => {
    assert.equal(call.headers.get('Authorization'), `Bearer ${configured.DASHSCOPE_API_KEY}`);
    assert.notEqual(call.headers.get('Authorization'), `Bearer ${process.env.DASHSCOPE_API_KEY}`);
    return call.body.input.action === 'create_voice' ? reply({ voice_id: voiceId }) : reply({ status: 'OK', target_model: model });
  });
  assert.deepEqual(await s.run({ credentials: configured }), { voiceId });
  assert.equal(s.uploads.length, 1); assert.equal(s.uploads[0].credentials, configured);
  assert.deepEqual({ ...process.env }, environmentBefore);
  for (const command of s.commands) for (const [key, value] of Object.entries(configured)) {
    assert.equal(command.options.env[key], undefined);
    assert.ok(!Object.values(command.options.env).includes(value));
  }
  noSecrets(s, configured);
});

test('an explicit empty or incomplete settings map never falls back to CLI environment credentials', async t => {
  for (const configured of [{}, { YIDEVS_API_KEY: 'settings-map-without-dashscope' }]) {
    await t.test(Object.keys(configured).length ? 'missing DashScope key' : 'empty map', async child => {
      const s = sandbox(child);
      assert.ok(process.env.DASHSCOPE_API_KEY);
      await assert.rejects(s.run({ credentials: configured }), error => {
        assert.equal(error.code, 'CLONE_CONFIG'); assert.match(error.message, /设置|settings/i);
        assert.ok(!error.message.includes(process.env.DASHSCOPE_API_KEY)); return true;
      });
      assert.equal(s.commands.length, 0); assert.equal(s.uploads.length, 0); assert.equal(s.calls.length, 0);
      assert.equal(existsSync(s.recordPath), false); assert.equal(existsSync(path.join(s.directory, 'clone-request.lock')), false);
    });
  }
});

test('Harness credentials never enter global environment, bootstrap or media subprocess environments, or saved records', async t => {
  const s = sandbox(t), configured = settingsCredentials(), environmentBefore = { ...process.env };
  let installed = false, bootstraps = 0;
  s.mock(call => {
    assert.equal(call.headers.get('Authorization'), `Bearer ${configured.DASHSCOPE_API_KEY}`);
    return call.body.input.action === 'create_voice' ? reply({ voice_id: voiceId }) : reply({ status: 'OK', target_model: model });
  });
  await s.run({ credentials: configured, internal: { run: async (command, args, options) => {
    assert.deepEqual({ ...process.env }, environmentBefore);
    for (const [key, value] of Object.entries({ ...credentials, ...configured })) {
      assert.equal(options.env[key], undefined); assert.ok(!Object.values(options.env).includes(value));
    }
    if (command === process.execPath) {
      bootstraps++; assert.deepEqual(args, ['scripts/bootstrap.mjs']); assert.equal(options.cwd, s.workspace);
      installed = true;
      for (const name of ['ffmpeg', 'ffprobe']) { mkdirSync(path.dirname(s.managed(name)), { recursive: true }); writeFileSync(s.managed(name), 'mock executable'); }
      return '';
    }
    if (args.includes('-version') && !installed) throw new Error('mock tool missing');
    return s.defaultRun(command, args, options);
  } } });
  assert.equal(bootstraps, 1); assert.equal(s.uploads[0].credentials, configured);
  assert.deepEqual({ ...process.env }, environmentBefore); noSecrets(s, configured);
});

test('create rejects an apparent voice ID containing a settings-map secret without leaking or persisting it', async t => {
  for (const key of ['DASHSCOPE_API_KEY', 'YIDEVS_API_KEY', 'MOTION_OSS_ACCESS_KEY_ID', 'MOTION_OSS_ACCESS_KEY_SECRET', 'MOTION_OSS_SECURITY_TOKEN']) {
    await t.test(key, async child => {
      const s = sandbox(child), configured = settingsCredentials(), secret = configured[key];
      s.mock(() => reply({ voice_id: `cosyvoice-v3.5-plus-${secret}` }));
      await assert.rejects(s.run({ credentials: configured }), error => {
        assert.equal(error.code, 'CLONE_UNCERTAIN');
        for (const value of Object.values(configured)) assert.ok(!error.message.includes(value));
        return true;
      });
      assert.equal(s.record().status, 'submission-uncertain'); assert.equal(s.record().voiceId, undefined);
      assert.equal(s.calls.length, 1); assert.equal(s.uploads[0].credentials, configured); noSecrets(s, configured);
      await assert.rejects(s.run({ credentials: configured })); assert.equal(s.calls.length, 1);
    });
  }
});

test('saved voice ID validation also uses settings secrets instead of the global environment', async t => {
  const s = sandbox(t), configured = settingsCredentials();
  s.seed('processing', `cosyvoice-v3.5-plus-${configured.MOTION_OSS_ACCESS_KEY_SECRET}`);
  await assert.rejects(s.run({ credentials: configured }), error => {
    assert.equal(error.code, 'CLONE_RECORD'); assert.ok(!error.message.includes(configured.MOTION_OSS_ACCESS_KEY_SECRET)); return true;
  });
  assert.equal(s.calls.length, 0); assert.equal(s.commands.length, 0); assert.equal(s.uploads.length, 0);
  assert.equal(existsSync(path.join(s.directory, 'clone-request.lock')), false);
});

test('clone extracts a bounded PCM sample and uses the official enrollment protocol with saved submission state', async t => {
  const s = sandbox(t), stages = [], started = deferred(), release = deferred();
  let held = false;
  const operation = s.run({ onStage: async stage => { stages.push(stage); if (!held) { held = true; started.resolve(); await release.promise; } } });
  await started.promise;
  assert.equal(s.calls.length, 0);
  release.resolve();
  s.mock(call => {
    assert.equal(call.url, endpoint); assert.equal(call.method, 'POST');
    assert.equal(call.headers.get('Authorization'), `Bearer ${credentials.DASHSCOPE_API_KEY}`);
    assert.equal(call.headers.get('Content-Type'), 'application/json'); assert.equal(call.redirect, 'error');
    assert.equal(call.body.model, 'voice-enrollment');
    if (call.body.input.action === 'create_voice') {
      const { prefix } = call.body.input;
      assert.match(prefix, /^[a-zA-Z0-9]{1,10}$/);
      assert.deepEqual(call.body, { model: 'voice-enrollment', input: { action: 'create_voice', target_model: model, prefix, url: signedURL, language_hints: ['zh'] } });
      assert.equal(s.record().status, 'submission-uncertain'); assert.equal(s.record().voiceId, undefined);
      return reply({ voice_id: voiceId });
    }
    assert.deepEqual(call.body, { model: 'voice-enrollment', input: { action: 'query_voice', voice_id: voiceId } });
    assert.equal(s.record().voiceId, voiceId);
    return reply({ voice_id: voiceId, status: 'OK', target_model: model });
  });
  assert.deepEqual(await operation, { voiceId });
  assert.ok(stages.length > 0); assert.equal(s.uploads.length, 1);
  const extract = s.commands.find(call => path.basename(call.command).startsWith('ffmpeg') && !call.args.includes('-version'));
  assert.ok(extract); assert.equal(argument(extract.args, '-ar'), '24000'); assert.equal(argument(extract.args, '-ac'), '1');
  assert.equal(argument(extract.args, '-c:a', '-acodec', '-codec:a'), 'pcm_s16le');
  assert.ok(Number(argument(extract.args, '-t')) > 0 && Number(argument(extract.args, '-t')) <= 20);
  assert.equal(argument(extract.args, '-map'), '0:a:0');
  const upload = s.uploads[0]; assert.equal(upload.filePath, path.join(s.directory, s.record().sampleFilename)); assert.equal(upload.contentType, 'audio/wav');
  assert.notEqual(upload.filePath, extract.args.at(-1)); assert.equal(existsSync(extract.args.at(-1)), false);
  assert.ok(upload.objectKey.endsWith('.wav')); assert.ok(existsSync(upload.filePath));
  const bytes = readFileSync(upload.filePath); assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.readUInt16LE(22), 1); assert.equal(bytes.readUInt32LE(24), 24000); assert.equal(bytes.readUInt16LE(34), 16);
  const record = s.record(); assert.equal(record.version, 1); assert.equal(record.status, 'ready'); assert.equal(record.targetModel, model);
  assert.equal(record.videoPath, s.videoPath); assert.ok(record.requestId); assert.equal(path.basename(record.sampleFilename), record.sampleFilename);
  assert.equal(s.calls.filter(call => call.body.input.action === 'create_voice').length, 1); noSecrets(s);
});

test('workspace managed tools take priority over overrides and PATH', async t => {
  const s = sandbox(t);
  for (const name of ['ffmpeg', 'ffprobe']) { mkdirSync(path.dirname(s.managed(name)), { recursive: true }); writeFileSync(s.managed(name), 'mock executable'); process.env[`${name.toUpperCase()}_PATH`] = path.join(s.workspace, `${name}-override`); }
  await s.run();
  for (const name of ['ffmpeg', 'ffprobe']) {
    const checks = s.commands.filter(call => call.args.includes('-version') && path.basename(call.command).startsWith(name));
    assert.ok(checks.some(call => call.command === s.managed(name)));
    assert.ok(s.commands.filter(call => !call.args.includes('-version') && path.basename(call.command).startsWith(name)).every(call => call.command === s.managed(name)));
  }
});

test('tools fall back to explicit environment paths before PATH commands', async t => {
  const s = sandbox(t);
  for (const name of ['ffmpeg', 'ffprobe']) { const filename = path.join(s.workspace, `${name}${process.platform === 'win32' ? '.exe' : ''}`); writeFileSync(filename, 'mock executable'); process.env[`${name.toUpperCase()}_PATH`] = filename; }
  await s.run();
  for (const name of ['ffmpeg', 'ffprobe']) assert.ok(s.commands.filter(call => !call.args.includes('-version') && path.basename(call.command).startsWith(name)).every(call => call.command === process.env[`${name.toUpperCase()}_PATH`]));
});

test('missing media tools bootstrap once in the production workspace without cloud credentials', async t => {
  const s = sandbox(t); let installed = false, bootstraps = 0;
  await s.run({ internal: { run: async (command, args, options) => {
    if (command === process.execPath) {
      bootstraps++; assert.deepEqual(args, ['scripts/bootstrap.mjs']); assert.equal(options.cwd, s.workspace);
      for (const [key, value] of Object.entries(credentials)) { assert.equal(options.env[key], undefined); assert.ok(!Object.values(options.env).includes(value)); }
      assert.ok(options.env.PATH || options.env.Path);
      installed = true;
      for (const name of ['ffmpeg', 'ffprobe']) { mkdirSync(path.dirname(s.managed(name)), { recursive: true }); writeFileSync(s.managed(name), 'mock executable'); }
      return '';
    }
    if (args.includes('-version') && !installed) throw new Error('mock tool missing');
    return s.defaultRun(command, args, options);
  } } });
  assert.equal(bootstraps, 1); assert.equal(s.uploads.length, 1);
});

test('source without audio or with less than five seconds never uploads or creates a voice', async t => {
  for (const media of [{ streams: [{ codec_type: 'video' }], format: { duration: '20' } }, { streams: [{ codec_type: 'audio' }], format: { duration: '4.99' } }, { streams: [{ codec_type: 'audio' }], format: { duration: 'NaN' } }]) {
    await t.test(JSON.stringify(media), async child => {
      const s = sandbox(child);
      await assert.rejects(s.run({ internal: { run: (command, args, options) => args.includes('-version') ? s.defaultRun(command, args, options) : Promise.resolve(JSON.stringify(media)) } }));
      assert.equal(s.uploads.length, 0); assert.equal(s.calls.length, 0);
    });
  }
});

test('bad extracted format, duration, or oversized sample fails before uploading', async t => {
  for (const [label, sample, bytes] of [
    ['stereo', { ...goodSample, streams: [{ ...goodSample.streams[0], channels: 2 }] }],
    ['wrong rate', { ...goodSample, streams: [{ ...goodSample.streams[0], sample_rate: '48000' }] }],
    ['wrong codec', { ...goodSample, streams: [{ ...goodSample.streams[0], codec_name: 'pcm_f32le', bits_per_sample: 32 }] }],
    ['too short', { ...goodSample, format: { duration: '4' } }],
    ['too long', { ...goodSample, format: { duration: '21' } }],
    ['oversized file', goodSample, Buffer.alloc(11 * 1024 * 1024)],
  ]) {
    await t.test(label, async child => {
      const s = sandbox(child);
      await assert.rejects(s.run({ internal: { run: async (command, args, options) => {
        if (!args.includes('-version') && path.basename(command).startsWith('ffprobe') && args.at(-1) !== s.videoPath) return JSON.stringify(sample);
        const result = await s.defaultRun(command, args, options);
        if (bytes && !args.includes('-version') && path.basename(command).startsWith('ffmpeg')) writeFileSync(args.at(-1), bytes);
        return result;
      } } }));
      assert.equal(s.uploads.length, 0); assert.equal(s.calls.length, 0);
    });
  }
});

test('uncertain submission without an ID fails closed and never recreates', async t => {
  const s = sandbox(t); s.seed('submission-uncertain');
  await assert.rejects(s.run()); await assert.rejects(s.run());
  assert.equal(s.calls.length, 0); assert.equal(s.commands.length, 0); assert.equal(s.uploads.length, 0);
  assert.equal(s.record().status, 'submission-uncertain'); noSecrets(s);
});

test('saved voice ID resumes with query only even if the source no longer exists', async t => {
  const s = sandbox(t); s.seed('processing', voiceId); unlinkSync(s.videoPath);
  assert.deepEqual(await s.run({ internal: { run: async () => { throw new Error('Resume must not invoke media tools.'); }, upload: async () => { throw new Error('Resume must not upload.'); } } }), { voiceId });
  assert.equal(s.calls.length, 1); assert.equal(s.calls[0].body.input.action, 'query_voice'); assert.equal(s.record().status, 'ready'); noSecrets(s);
});

test('query cannot substitute a different voice ID, and retry still queries the saved one', async t => {
  const s = sandbox(t); s.seed('processing', voiceId); unlinkSync(s.videoPath);
  s.mock(() => reply({ voice_id: 'cosyvoice-v3.5-plus-other-mock', status: 'OK', target_model: model }));
  await assert.rejects(s.run(), error => { assert.equal(error.code, 'CLONE_RESPONSE'); return true; });
  assert.equal(s.record().voiceId, voiceId); assert.notEqual(s.record().status, 'ready');
  s.mock(() => reply({ voice_id: voiceId, status: 'OK', target_model: model }));
  assert.deepEqual(await s.run(), { voiceId }); assert.equal(s.calls.length, 2);
  assert.ok(s.calls.every(call => call.body.input.action === 'query_voice' && call.body.input.voice_id === voiceId));
  assert.equal(s.commands.length, 0); assert.equal(s.uploads.length, 0); noSecrets(s);
});

test('official query response without a voice_id confirms the saved ID through status and exact target model', async t => {
  const s = sandbox(t); s.seed('processing', voiceId); unlinkSync(s.videoPath);
  s.mock(() => reply({ status: 'OK', target_model: model }));
  assert.deepEqual(await s.run(), { voiceId }); assert.equal(s.record().status, 'ready'); assert.equal(s.record().voiceId, voiceId);
  assert.equal(s.calls.length, 1); assert.deepEqual(s.calls[0].body.input, { action: 'query_voice', voice_id: voiceId });
  assert.equal(s.commands.length, 0); assert.equal(s.uploads.length, 0); noSecrets(s);
});

test('prepared retry preserves its existing PCM sample instead of extracting again', async t => {
  const s = sandbox(t);
  await assert.rejects(s.run({ internal: { upload: async () => { throw new Error('Mock upload interrupted before submission.'); } } }));
  const prepared = s.record(), sample = path.join(s.directory, prepared.sampleFilename), bytes = readFileSync(sample);
  assert.equal(prepared.status, 'prepared'); assert.match(prepared.sourceSha256, /^[0-9a-f]{64}$/);
  assert.equal(s.calls.length, 0);
  s.commands.length = 0;
  assert.deepEqual(await s.run(), { voiceId });
  assert.equal(s.record().requestId, prepared.requestId); assert.equal(s.record().sampleFilename, prepared.sampleFilename);
  assert.deepEqual(readFileSync(sample), bytes);
  assert.ok(!s.commands.some(call => path.basename(call.command).startsWith('ffmpeg') && !call.args.includes('-version')));
  assert.equal(s.calls.filter(call => call.body.input.action === 'create_voice').length, 1); noSecrets(s);
});

test('prepared retry rejects changed source bytes before tools, upload, or paid creation', async t => {
  const s = sandbox(t);
  await assert.rejects(s.run({ internal: { upload: async () => { throw new Error('Mock upload interrupted before submission.'); } } }));
  const prepared = s.record();
  writeFileSync(s.videoPath, Buffer.concat([readFileSync(s.videoPath), Buffer.from('changed-source')]));
  s.commands.length = 0;
  await assert.rejects(s.run(), error => { assert.equal(error.code, 'CLONE_INPUT'); return true; });
  assert.deepEqual(s.record(), prepared); assert.equal(s.commands.length, 0); assert.equal(s.uploads.length, 0); assert.equal(s.calls.length, 0); noSecrets(s);
});

test('DEPLOYING polls until OK and confirms the exact target model', async t => {
  const s = sandbox(t); s.seed('processing', voiceId); let queries = 0;
  s.mock(() => reply({ voice_id: voiceId, target_model: model, status: ++queries === 1 ? 'DEPLOYING' : 'OK' }));
  assert.deepEqual(await s.run(), { voiceId }); assert.equal(queries, 2); assert.equal(s.waits.length, 1); noSecrets(s);
});

test('undeployed or wrong-model IDs remain saved and can only be queried again', async t => {
  for (const output of [{ voice_id: voiceId, status: 'UNDEPLOYED', target_model: model }, { voice_id: voiceId, status: 'OK', target_model: 'cosyvoice-v3-plus' }]) {
    await t.test(output.target_model + '/' + output.status, async child => {
      const s = sandbox(child); s.seed('processing', voiceId); s.mock(() => reply(output));
      await assert.rejects(s.run()); assert.equal(s.record().status, 'rejected'); assert.equal(s.record().voiceId, voiceId);
      s.mock(() => reply({ voice_id: voiceId, status: 'OK', target_model: model }));
      assert.deepEqual(await s.run(), { voiceId }); assert.ok(s.calls.every(call => call.body.input.action === 'query_voice'));
      assert.equal(s.commands.length, 0); assert.equal(s.uploads.length, 0); noSecrets(s);
    });
  }
});

test('cancellation before starting and immediately after awaited stage prevents paid create', async t => {
  for (const abortedBefore of [true, false]) {
    await t.test(abortedBefore ? 'already aborted' : 'stage abort', async child => {
      const s = sandbox(child), controller = new AbortController();
      if (abortedBefore) controller.abort();
      await assert.rejects(s.run({ signal: controller.signal, onStage: async () => { await Promise.resolve(); controller.abort(); } }));
      assert.equal(s.calls.length, 0); assert.ok(!existsSync(path.join(s.directory, 'clone-request.lock')));
    });
  }
});

test('cancellation after the awaited create stage leaves a durable uncertain record and no paid request', async t => {
  const s = sandbox(t), controller = new AbortController();
  await assert.rejects(s.run({ signal: controller.signal, onStage: async stage => {
    await Promise.resolve(); if (stage === '正在创建人物音色') controller.abort();
  } }));
  assert.equal(s.uploads.length, 1); assert.equal(s.calls.length, 0); assert.equal(s.record().status, 'submission-uncertain');
  await assert.rejects(s.run()); assert.equal(s.calls.length, 0); noSecrets(s);
});

test('poll timeout preserves the ID and retry never submits another create', async t => {
  const s = sandbox(t); s.seed('processing', voiceId); s.mock(() => reply({ voice_id: voiceId, status: 'DEPLOYING', target_model: model }));
  await assert.rejects(s.run({ internal: { timeoutMs: 200, pollMs: 100 } }));
  assert.equal(s.record().voiceId, voiceId); assert.ok(s.waits.length > 0);
  s.mock(() => reply({ voice_id: voiceId, status: 'OK', target_model: model }));
  assert.deepEqual(await s.run(), { voiceId }); assert.ok(s.calls.every(call => call.body.input.action === 'query_voice')); noSecrets(s);
});

test('request timeout leaves an uncertain create that cannot be automatically resubmitted', { timeout: 5000 }, async t => {
  const s = sandbox(t);
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  s.mock(call => new Promise((resolve, reject) => {
    if (call.signal.aborted) reject(call.signal.reason);
    else call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true });
  }));
  await assert.rejects(s.run({ internal: { requestTimeoutMs: 20 } }));
  assert.equal(s.record().status, 'submission-uncertain'); assert.equal(s.record().voiceId, undefined);
  await assert.rejects(s.run()); assert.equal(s.calls.length, 1); noSecrets(s);
});

test('upstream HTTP failures, malformed replies and oversized JSON expose no response secrets', async t => {
  const secretBody = `upstream-secret ${credentials.DASHSCOPE_API_KEY} ${signedURL}`;
  for (const [label, response] of [
    ['HTTP failure', () => Response.json({ code: 'InvalidParameter', message: secretBody }, { status: 400 })],
    ['invalid JSON', () => new Response(secretBody)],
    ['missing ID', () => reply({})],
    ['oversized JSON', () => Response.json({ output: { voice_id: voiceId }, padding: 'x'.repeat(1024 * 1024 + 1) })],
  ]) {
    await t.test(label, async child => {
      const s = sandbox(child); s.mock(response);
      await assert.rejects(s.run(), error => { assert.ok(!error.message.includes(secretBody)); assert.ok(!error.message.includes(credentials.DASHSCOPE_API_KEY)); assert.ok(!error.message.includes(signedURL)); return true; });
      assert.equal(s.calls.length, 1); noSecrets(s);
    });
  }
});

test('existing lock and active parallel invocation prevent duplicate voice creation', async t => {
  const s = sandbox(t), lock = path.join(s.directory, 'clone-request.lock');
  writeFileSync(lock, 'existing lock');
  await assert.rejects(s.run()); assert.equal(s.calls.length, 0); assert.equal(readFileSync(lock, 'utf8'), 'existing lock');
  unlinkSync(lock);
  const entered = deferred(), release = deferred();
  s.mock(async call => {
    if (call.body.input.action === 'create_voice') { entered.resolve(); await release.promise; return reply({ voice_id: voiceId }); }
    return reply({ voice_id: voiceId, status: 'OK', target_model: model });
  });
  const first = s.run(); await entered.promise;
  try { await assert.rejects(s.run()); assert.equal(s.calls.length, 1); }
  finally { release.resolve(); }
  assert.deepEqual(await first, { voiceId });
  assert.equal(s.calls.filter(call => call.body.input.action === 'create_voice').length, 1); noSecrets(s);
});
