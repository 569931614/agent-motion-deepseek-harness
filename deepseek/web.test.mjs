import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Studio as HostStudio, validateInput } from './lib/web.js';
import { mediaPath } from '../scripts/media-tools.mjs';
import { createWorkspace } from './create-workspace.mjs';

const input = { subtitles: '學習讓資訊更清晰。', title: '學會拆解問題', voiceSource: 'existing', voice: 'cosyvoice-test-model-voice', style: 'education', width: 1920, height: 1080 };
const srt = '1\n00:00:00,000 --> 00:00:01,000\n学习让资讯更清晰。';
const video = Buffer.alloc(32);
video.writeUInt32BE(video.length, 0);
video.write('ftyp', 4);
video.write('isom', 8);
const hasStatus = status => error => error.status === status;
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const providers = {
  configurationError: () => undefined,
  async cloneVideoVoice(options) { options.signal.throwIfAborted(); return { voiceId: 'cosyvoice-v3.5-plus-cloned-voice' }; },
  async synthesizeVoice(options) { await options.onSubmitted?.(); options.signal.throwIfAborted(); writeFileSync(options.output, 'mock voice'); return { audioPath: options.output }; },
  async generateAvatar(options) { options.signal.throwIfAborted(); writeFileSync(options.output, video); return { videoPath: options.output, taskId: 'upstream-task' }; },
};
function credentialStore(env = { DASHSCOPE_API_KEY: 'test-only-key' }) {
  let record = { kind: 'api-key', env: { ...env } };
  return {
    writable: true,
    writes: 0,
    async readRecord(key) { assert.equal(key, 'agent-motion/cloud'); return structuredClone(record); },
    async describeRecord(key) { assert.equal(key, 'agent-motion/cloud'); return { configured: !!record, writable: this.writable }; },
    async modifyRecord(key, mutate) { assert.equal(key, 'agent-motion/cloud'); record = await mutate(structuredClone(record)); this.writes++; return structuredClone(record); },
  };
}
class Studio extends HostStudio {
  constructor(storage, controller, workspaces, provider = providers, credentials = credentialStore()) {
    super(storage, controller, workspaces, provider, credentials);
  }
}
async function executeAndWait(studio, task, controller) {
  await studio.execute(task.id, new AbortController().signal);
  const deadline = Date.now() + 5000;
  while (!controller.prompts.some(row => row.requestId === task.id) && !['failed', 'cancelled', 'stopping'].includes(task.status)) {
    if (Date.now() > deadline) throw new Error('Cloud preprocessing did not reach the Skill session');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
function uploadRequest(body = video, extra = {}) {
  return new Request('http://localhost/api/agent-motion/upload', {
    method: 'POST', body, duplex: 'half', ...extra,
    headers: { 'content-type': 'application/octet-stream', ...extra.headers },
  });
}
function mockController() {
  const calls = [], prompts = [], sessions = new Map();
  return {
    calls, prompts, sessions,
    async create(request) {
      calls.push({ name: 'create', request });
      await this.createHook?.();
      const sessionId = randomUUID();
      sessions.set(sessionId, { events: [], inbox: { 'next-turn': [], 'next-step': [] } });
      return { sessionId };
    },
    async rename(request) { calls.push({ name: 'rename', request }); return { title: request.title }; },
    async prompt(request) {
      calls.push({ name: 'prompt', request });
      prompts.push(request);
      sessions.get(request.sessionId).inbox['next-turn'].push({ id: randomUUID(), source: { kind: 'user', rpcId: request.requestId }, content: request.content });
      await this.promptHook?.();
      return { accepted: true };
    },
    async inspect(sessionId) {
      calls.push({ name: 'inspect', sessionId });
      return this.inspectHook ? this.inspectHook(sessionId) : { events: sessions.get(sessionId).events };
    },
    async projections(request) {
      calls.push({ name: 'projections', request });
      await this.projectionHook?.();
      return { asOfSeq: 0, values: { inbox: sessions.get(request.sessionId).inbox } };
    },
    async updateQueue(request) {
      calls.push({ name: 'updateQueue', request });
      assert.deepEqual(request.action, { kind: 'remove' });
      const inbox = sessions.get(request.sessionId).inbox;
      for (const target of ['next-turn', 'next-step']) inbox[target] = inbox[target].filter(message => message.id !== request.itemId);
      return { accepted: true };
    },
    cancel(request) {
      calls.push({ name: 'cancel', request });
      this.cancelHook?.();
      return { accepted: true };
    },
  };
}
function terminalEvents(kind, skill = false) {
  return [
    { seq: 0, type: 'turn/start', data: {} },
    ...(skill ? [
      { seq: 1, type: 'tool/call', data: { name: 'skill', callId: 'skill-call', arguments: JSON.stringify({ name: 'agent-motion' }) } },
      { seq: 2, type: 'tool/result', data: { message: { toolCallId: 'skill-call', isError: false } } },
    ] : []),
    { seq: 3, type: 'turn/end', data: { reason: { kind } } },
  ];
}

test('settings persist through the Harness credential seam, retain blank secrets and expose only presence', async () => {
  const store = credentialStore({});
  const controller = mockController();
  const studio = new Studio('settings-only-no-files', controller, undefined, providers, store);
  assert.equal((await studio.settings()).ready, false);
  assert.equal((await studio.settings()).values.MOTION_OSS_ENDPOINT, 'https://cos.ap-beijing.myqcloud.com');
  const values = {
    DASHSCOPE_API_KEY: 'mock-dashscope-settings-secret',
    YIDEVS_API_KEY: 'mock-yidevs-settings-secret',
    MOTION_OSS_ENDPOINT: 'https://cos.ap-beijing.myqcloud.com',
    MOTION_OSS_BUCKET: 'motion-test-bucket-1250000000',
    MOTION_OSS_ACCESS_KEY_ID: 'mock-oss-settings-id',
    MOTION_OSS_ACCESS_KEY_SECRET: 'mock-oss-settings-secret',
    MOTION_OSS_SECURITY_TOKEN: 'mock-sts-settings-secret',
    COSYVOICE_VOICE_ID: 'cosyvoice-v3.5-plus-settings',
  };
  const result = await studio.settings({ values });
  assert.equal(result.ready, true);
  assert.equal(store.writes, 1);
  assert.deepEqual(result.values, { MOTION_OSS_ENDPOINT: values.MOTION_OSS_ENDPOINT, MOTION_OSS_BUCKET: values.MOTION_OSS_BUCKET, COSYVOICE_VOICE_ID: values.COSYVOICE_VOICE_ID });
  for (const name of ['DASHSCOPE_API_KEY', 'YIDEVS_API_KEY', 'MOTION_OSS_ACCESS_KEY_ID', 'MOTION_OSS_ACCESS_KEY_SECRET', 'MOTION_OSS_SECURITY_TOKEN']) {
    assert.equal(result.configured[name], true);
    assert.ok(!JSON.stringify(result).includes(values[name]));
  }
  await studio.settings({ values: { DASHSCOPE_API_KEY: '', MOTION_OSS_BUCKET: 'motion-other-bucket-1250000000' } });
  assert.equal((await store.readRecord('agent-motion/cloud')).env.DASHSCOPE_API_KEY, values.DASHSCOPE_API_KEY);
  const reopened = new Studio('settings-only-no-files', controller, undefined, providers, store);
  assert.equal((await reopened.settings()).values.MOTION_OSS_BUCKET, 'motion-other-bucket-1250000000');
  await reopened.settings({ values: { DASHSCOPE_API_KEY: null, MOTION_OSS_SECURITY_TOKEN: null, COSYVOICE_VOICE_ID: '' } });
  const cleared = await reopened.settings();
  assert.equal(cleared.ready, false);
  assert.equal(cleared.configured.DASHSCOPE_API_KEY, false);
  assert.equal(cleared.configured.MOTION_OSS_SECURITY_TOKEN, false);
  assert.equal(cleared.defaultVoice, '');
  assert.match(cleared.message, /设置/);
  assert.equal(controller.calls.length, 0);
});

test('settings reject invalid and read-only writes and hide storage errors', async () => {
  const store = credentialStore();
  const studio = new Studio('settings-only-no-files', mockController(), undefined, providers, store);
  for (const value of [null, [], {}, { values: [] }, { values: {}, other: 'bad' },
    { values: { UNKNOWN_KEY: 'bad' } }, { values: { DASHSCOPE_API_KEY: 2 } }, { values: { DASHSCOPE_API_KEY: 'a\nb' } },
    { values: { DASHSCOPE_API_KEY: 'a'.repeat(8193) } }, { values: { MOTION_OSS_ENDPOINT: 'https://example.com' } },
    { values: { MOTION_OSS_ENDPOINT: 'https://oss-cn-beijing.aliyuncs.com' } },
    { values: { MOTION_OSS_ENDPOINT: 'https://cos.ap-beijing.myqcloud.com/?secret=x' } },
    { values: { MOTION_OSS_ENDPOINT: 'https://bucket-1250000000.cos.ap-beijing.myqcloud.com' } },
    { values: { MOTION_OSS_BUCKET: 'Bad bucket' } }, { values: { MOTION_OSS_BUCKET: 'missing-appid' } },
    { values: { MOTION_OSS_ACCESS_KEY_ID: 'bad&id' } },
    { values: { COSYVOICE_VOICE_ID: 'a b' } }]) {
    await assert.rejects(studio.settings(value), hasStatus(400));
  }
  assert.equal(store.writes, 0);
  const prior = await store.readRecord('agent-motion/cloud');
  await assert.rejects(studio.settings({ values: {
    DASHSCOPE_API_KEY: 'replacement-not-saved', MOTION_OSS_ENDPOINT: 'https://oss-cn-beijing.aliyuncs.com',
  } }), hasStatus(400));
  assert.deepEqual(await store.readRecord('agent-motion/cloud'), prior);
  store.writable = false;
  await assert.rejects(studio.settings({ values: { DASHSCOPE_API_KEY: 'new' } }), hasStatus(503));
  assert.equal((await studio.settings()).writable, false);
  const poison = 'synthetic-secret-not-for-responses';
  for (const method of ['readRecord', 'describeRecord', 'modifyRecord']) {
    const broken = { ...credentialStore(), async [method]() { throw new Error(poison); } };
    const failing = new Studio('settings-only-no-files', mockController(), undefined, providers, broken);
    const request = new Request('http://localhost/api/agent-motion/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: { DASHSCOPE_API_KEY: 'new' } }),
    });
    const response = await failing.api('settings', request);
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes(poison));
  }
});

test('Web studio follows real Harness task, upload, cancellation and file contracts', { timeout: 60000 }, async t => {
  const key = process.env.DASHSCOPE_API_KEY; process.env.DASHSCOPE_API_KEY = 'test-only-key';
  t.after(() => { if (key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = key; });
  const temporaryParent = realpathSync(tmpdir());
  const temporary = mkdtempSync(path.join(temporaryParent, 'agent-motion web-'));
  const links = [];
  t.after(() => {
    assert.equal(path.dirname(realpathSync(temporary)), temporaryParent);
    for (const link of links) if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(link);
    rmSync(temporary, { recursive: true, force: true });
  });
  const controller = mockController();
  const storage = path.join(temporary, 'studio');
  let studio = new Studio(storage, controller, undefined, providers);
  const ready = async (value = input) => {
    const task = await studio.create(value);
    await studio.upload(task.id, uploadRequest());
    return task;
  };
  const execute = task => executeAndWait(studio, task, controller);
  const saved = task => JSON.parse(readFileSync(path.join(storage, 'tasks', `${task.id}.json`), 'utf8'));

  await t.test('one settings snapshot reaches cloud providers and the next job sees saved updates', async () => {
    const store = credentialStore({ DASHSCOPE_API_KEY: 'snapshot-before' });
    const seen = [], sessions = mockController();
    const production = new Studio(path.join(temporary, 'settings-snapshot'), sessions, undefined, { ...providers,
      async cloneVideoVoice(options) {
        seen.push(options.credentials); assert.equal(options.credentials.DASHSCOPE_API_KEY, 'snapshot-before');
        await production.settings({ values: { DASHSCOPE_API_KEY: 'snapshot-after' } });
        return providers.cloneVideoVoice(options);
      },
      async synthesizeVoice(options) { seen.push(options.credentials); return providers.synthesizeVoice(options); },
      async generateAvatar(options) { seen.push(options.credentials); return providers.generateAvatar(options); },
    }, store);
    const first = await production.create({ ...input, voiceSource: 'video' });
    await production.upload(first.id, uploadRequest()); await executeAndWait(production, first, sessions);
    assert.equal(seen.length, 3); assert.ok(seen.every(item => item === seen[0]));
    assert.equal(seen[0].DASHSCOPE_API_KEY, 'snapshot-before');
    assert.ok(!JSON.stringify(production.publicTask(first)).includes('snapshot-before'));
    assert.ok(!sessions.prompts[0].content[0].text.includes('snapshot-before'));
    assert.ok(!readFileSync(path.join(production.storage, 'tasks', first.id + '.json'), 'utf8').includes('snapshot-before'));
    await production.cancel(first.id);
    const second = await production.create(input); await production.upload(second.id, uploadRequest());
    await executeAndWait(production, second, sessions);
    assert.equal(seen[3].DASHSCOPE_API_KEY, 'snapshot-after');
    await production.cancel(second.id);
  });

  await t.test('video voice mode obtains a model voice before narration and avatar generation', async () => {
    const order = [], sessions = mockController();
    const automatic = new Studio(path.join(temporary, 'video-voice'), sessions, undefined, { ...providers,
      async cloneVideoVoice(options) {
        order.push('clone'); assert.equal(options.workspace, automatic.workspace);
        assert.ok(options.videoPath.endsWith('source.mp4')); await options.onStage('复刻视频音色');
        return { voiceId: 'cosyvoice-v3.5-plus-video-created' };
      },
      async synthesizeVoice(options) { order.push('narration'); assert.equal(options.voice, 'cosyvoice-v3.5-plus-video-created'); return providers.synthesizeVoice(options); },
      async generateAvatar(options) { order.push('avatar'); return providers.generateAvatar(options); },
    });
    const task = await automatic.create({ ...input, voiceSource: 'video', voice: 'ignored-old-voice' });
    assert.equal(task.voice, ''); await automatic.upload(task.id, uploadRequest());
    await executeAndWait(automatic, task, sessions);
    assert.deepEqual(order, ['clone', 'narration', 'avatar']);
    assert.equal(task.voiceSource, 'video'); assert.equal(task.voice, 'cosyvoice-v3.5-plus-video-created');
    const record = JSON.parse(readFileSync(path.join(automatic.storage, 'tasks', `${task.id}.json`), 'utf8'));
    assert.equal(record.voice, task.voice); assert.equal(sessions.prompts.length, 1);
    await automatic.cancel(task.id);
  });

  await t.test('cancelling video voice creation cannot continue into TTS or the Skill', async () => {
    const entered = deferred(); let narrationCalls = 0;
    const sessions = mockController();
    const automatic = new Studio(path.join(temporary, 'clone-cancel'), sessions, undefined, { ...providers,
      async cloneVideoVoice(options) {
        entered.resolve();
        await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('音色复刻已取消')), { once: true }));
        return { voiceId: 'never-created' };
      },
      async synthesizeVoice(options) { narrationCalls++; return providers.synthesizeVoice(options); },
    });
    const task = await automatic.create({ ...input, voiceSource: 'video', voice: undefined });
    await automatic.upload(task.id, uploadRequest());
    await automatic.execute(task.id, new AbortController().signal); await entered.promise;
    await automatic.cancel(task.id);
    assert.equal(task.status, 'cancelled'); assert.equal(task.voice, ''); assert.equal(narrationCalls, 0); assert.equal(sessions.prompts.length, 0);
  });

  await t.test('upgrades an existing workspace before paid submission while retaining user assets', async () => {
    const legacyStorage = path.join(temporary, 'legacy'); mkdirSync(legacyStorage);
    const workspace = createWorkspace(path.join(legacyStorage, 'production'));
    const script = path.join(workspace, 'scripts', 'prepare-avatar.mjs'); unlinkSync(script);
    const original = path.join(workspace, 'inputs', 'original.mp4'); writeFileSync(original, 'user original');
    const upgraded = new Studio(legacyStorage, mockController(), undefined, providers);
    const task = await upgraded.create(input);
    assert.ok(existsSync(script)); assert.equal(readFileSync(original, 'utf8'), 'user original');
    assert.equal(task.voiceSubmitted, undefined); await upgraded.cancel(task.id);
    writeFileSync(script, 'user changed script');
    const conflicting = new Studio(legacyStorage, mockController(), undefined, providers);
    await assert.rejects(conflicting.create(input), /不一致/);
    assert.equal(readFileSync(script, 'utf8'), 'user changed script');
  });

  await t.test('requires settings configuration before submitting paid work', async () => {
    const unavailable = new Studio(path.join(temporary, 'unconfigured'), mockController(), undefined, { ...providers, configurationError: () => '请配置 YIDEVS_API_KEY' });
    const task = await unavailable.create(input); await unavailable.upload(task.id, uploadRequest());
    await assert.rejects(unavailable.execute(task.id, new AbortController().signal), hasStatus(503));
    assert.equal(task.status, 'ready'); assert.equal(task.voiceSubmitted, undefined);
    assert.deepEqual(await unavailable.configuration(), { ready: false, message: '请配置 YIDEVS_API_KEY', defaultVoice: '' });
    await unavailable.cancel(task.id);
  });

  await t.test('returns immediately during TTS and cancellation never submits an avatar or Skill prompt', async () => {
    const began = deferred(), stopped = deferred(); let avatarCalls = 0;
    const cloud = { ...providers, async synthesizeVoice(options) {
      await options.onSubmitted(); began.resolve();
      await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { stopped.resolve(); reject(new Error('cancelled')); }, { once: true }));
      return { audioPath: options.output };
    }, async generateAvatar(options) { avatarCalls++; return providers.generateAvatar(options); } };
    const sessions = mockController();
    const background = new Studio(path.join(temporary, 'cloud-cancel'), sessions, undefined, cloud);
    const task = await background.create(input); await background.upload(task.id, uploadRequest());
    await background.execute(task.id, new AbortController().signal); await began.promise;
    assert.equal(task.stage, '生成配音'); assert.equal(task.voiceSubmitted, true);
    await assert.rejects(background.execute(task.id, new AbortController().signal), hasStatus(409));
    await background.cancel(task.id); await stopped.promise;
    assert.equal(task.status, 'cancelled'); assert.equal(avatarCalls, 0); assert.equal(sessions.prompts.length, 0);
    assert.equal(background.publicTask(task).media.audioUrl, undefined);
  });

  await t.test('avatar failure retains completed narration and stops before invoking the Skill', async () => {
    const sessions = mockController();
    const failed = new Studio(path.join(temporary, 'avatar-failure'), sessions, undefined, { ...providers, async generateAvatar() { throw new Error('数字人接口不可用'); } });
    const task = await failed.create(input); await failed.upload(task.id, uploadRequest());
    await executeAndWait(failed, task, sessions);
    assert.equal(task.status, 'failed'); assert.equal(sessions.prompts.length, 0);
    assert.match(task.message, /数字人接口不可用/); assert.equal(task.voiceReady, true);
    assert.ok(failed.publicTask(task).media.audioUrl.endsWith('/voice.wav'));
    assert.equal(failed.publicTask(task).media.avatarUrl, undefined);
  });

  await t.test('validates subtitle, title, style and dimensions before writing input', async () => {
    for (const value of [null, [], 'text', {}, { ...input, subtitles: '' }, { ...input, subtitles: ' '.repeat(10) },
      { ...input, subtitles: '字'.repeat(50001) }, { ...input, subtitles: '1\n00:00:02,000 --> 00:00:01,000\n字幕' },
      { ...input, style: '__proto__' }, { ...input, style: 'unknown' }, { ...input, width: 1919 },
      { ...input, title: 'English only' }, { ...input, title: '中文\n标题' }, { ...input, title: '字'.repeat(37) }, { ...input, voice: '' }, { ...input, voice: 'id\ninvalid' }, { ...input, voiceSource: 'unknown' }, { ...input, voiceSource: null }]) {
      assert.throws(() => validateInput(value));
    }
    assert.deepEqual(validateInput(input), { ...input, subtitles: '学习让资讯更清晰。', title: '学会拆解问题' });
    assert.equal(validateInput({ ...input, voiceSource: 'video', voice: undefined }).voice, '');
    assert.equal(validateInput({ ...input, voiceSource: undefined, voice: undefined }).voiceSource, 'video');
    assert.equal(validateInput({ ...input, voiceSource: undefined }).voiceSource, 'existing');
    assert.equal(validateInput({ ...input, voice: 'cosyvoice-v3.5-plus.saved' }).voice, 'cosyvoice-v3.5-plus.saved');
    for (const [width, height] of [[1920, 1080], [1080, 1920], [1080, 1080], [1280, 720]]) {
      assert.equal(validateInput({ ...input, width, height }).width, width);
    }
    const task = await studio.create({ ...input, subtitles: srt });
    assert.equal(readFileSync(path.join(studio.workspace, 'inputs', 'studio', task.id, 'source.srt'), 'utf8'), srt);
    assert.equal(studio.publicTask(task).subtitles, srt);
    assert.equal(readFileSync(path.join(studio.workspace, 'inputs', 'studio', task.id, 'narration.txt'), 'utf8'), '学习让资讯更清晰。');
    await studio.cancel(task.id);
  });

  await t.test('streams MP4 chunks, rejects malformed or incomplete uploads, and preserves completed input', async () => {
    const task = await studio.create(input);
    const directory = path.join(studio.workspace, 'inputs', 'studio', task.id);
    await assert.rejects(studio.upload(task.id, uploadRequest(video, { headers: { 'content-type': 'text/plain' } })), hasStatus(415));
    await assert.rejects(studio.upload(task.id, uploadRequest(video, { headers: { 'content-length': String(1024 ** 3 + 1) } })), hasStatus(413));
    await assert.rejects(studio.upload(task.id, uploadRequest(video, { headers: { 'content-length': 'invalid' } })), hasStatus(413));
    await assert.rejects(studio.upload(task.id, uploadRequest(Buffer.alloc(32))), /MP4/);
    await assert.rejects(studio.upload(task.id, uploadRequest(video, { headers: { 'content-length': '33' } })), /上传未完成/);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(studio.upload(task.id, uploadRequest(video, { signal: aborted.signal })), /上传未完成/);
    const broken = new ReadableStream({ pull(reader) { reader.error(new Error('stream interrupted')); } });
    await assert.rejects(studio.upload(task.id, uploadRequest(broken)), /stream interrupted/);
    assert.ok(!existsSync(path.join(directory, 'source.pending.mp4')));
    assert.ok(!existsSync(path.join(directory, 'source.mp4')));
    const chunks = new ReadableStream({ start(reader) { for (const chunk of [video.subarray(0, 6), video.subarray(6, 13), video.subarray(13)]) reader.enqueue(chunk); reader.close(); } });
    assert.equal((await studio.upload(task.id, uploadRequest(chunks, { headers: { 'content-length': String(video.length) } }))).status, 'ready');
    assert.deepEqual(readFileSync(path.join(directory, 'source.mp4')), video);
    await assert.rejects(studio.upload(task.id, uploadRequest()), hasStatus(409));
    assert.deepEqual(readFileSync(path.join(directory, 'source.mp4')), video);
    await studio.cancel(task.id);
  });

  await t.test('rejects simultaneous upload and removes an upload cancelled while streaming', async () => {
    const task = await studio.create(input);
    const reading = deferred(), finish = deferred();
    let chunk = 0;
    const stream = new ReadableStream({ async pull(reader) {
      if (chunk++ === 0) { reader.enqueue(video.subarray(0, 8)); return; }
      reading.resolve(); await finish.promise; reader.enqueue(video.subarray(8)); reader.close();
    } }, { highWaterMark: 0 });
    const pending = studio.upload(task.id, uploadRequest(stream));
    await reading.promise;
    await assert.rejects(studio.upload(task.id, uploadRequest()), hasStatus(409));
    assert.equal((await studio.cancel(task.id)).status, 'cancelled');
    const rejected = assert.rejects(pending, hasStatus(409));
    finish.resolve(); await rejected;
    const directory = path.join(studio.workspace, 'inputs', 'studio', task.id);
    assert.ok(!existsSync(path.join(directory, 'source.mp4')));
    assert.ok(!existsSync(path.join(directory, 'source.pending.mp4')));
  });

  await t.test('creates a real Skill session prompt and rejects repeated execution', async () => {
    const task = await ready();
    await execute(task);
    const prompt = controller.prompts.at(-1);
    assert.equal(prompt.sessionId, task.sessionId);
    assert.equal(prompt.requestId, task.id);
    assert.equal(prompt.mode, 'queue');
    assert.equal(controller.calls.find(call => call.name === 'create').request.cwd, studio.workspace);
    const text = prompt.content.map(part => part.text).join('\n');
    for (const marker of ['skill 工具加载 agent-motion', 'motion-craft', 'srt-reference-to-three', 'align-subtitles.mjs',
      `inputs/studio/${task.id}`, `work/${task.id}`, '教育风', '1920×1080', 'CosyVoice-v3.5-plus', 'MuseTalk', 'prepare-avatar.mjs', 'voiced-avatar.mp4']) assert.ok(text.includes(marker), marker);
    assert.ok(text.includes(`--srt inputs/studio/${task.id}/alignment/source.srt`));
    assert.match(task.ruleRevision, /^[a-f0-9]{64}$/);
    assert.ok(text.includes(`--rules-root inputs/studio/${task.id}/rules`));
    assert.ok(text.includes('--preview-only'));
    assert.ok(text.includes('实际制作要求、布局和效果必须落实当前 Skill 的修改'));
    assert.equal(JSON.parse(readFileSync(path.join(studio.workspace, 'inputs/studio', task.id, 'rules/revision.json'), 'utf8')).revision, task.ruleRevision);
    assert.equal(studio.publicTask(task).sessionUrl, '/');
    assert.equal(studio.publicTask(task).sessionTitle, `视频制作 · 教育风 · ${task.id.slice(0, 8)}`);
    assert.equal(controller.calls.find(call => call.name === 'rename' && call.request.sessionId === task.sessionId).request.title, studio.publicTask(task).sessionTitle);
    await assert.rejects(execute(task), hasStatus(409));
    const second = await ready();
    await assert.rejects(execute(second), hasStatus(409));
    await studio.cancel(second.id);
    await studio.cancel(task.id);
  });

  await t.test('bridges only owned approvals and allows one scoped decision without replay', async () => {
    const inspectCount = controller.calls.filter(call => call.name === 'inspect').length;
    let delegated = 0;
    assert.equal(await studio.requestApproval({ agent: { id: randomUUID() }, callId: 'unrelated', toolName: 'pwsh' }, async () => {
      delegated++; return 'unavailable';
    }), 'unavailable');
    assert.equal(delegated, 1);
    assert.equal(controller.calls.filter(call => call.name === 'inspect').length, inspectCount);

    const task = await ready(); await execute(task);
    const other = await ready();
    const callId = randomUUID(), args = { command: 'node --version' };
    controller.sessions.get(task.sessionId).events.push({ seq: 0, type: 'tool/call', data: { name: 'pwsh', callId, arguments: JSON.stringify(args) } });
    const abort = new AbortController();
    const outcome = studio.requestApproval({ agent: { id: task.sessionId }, callId, toolName: 'pwsh', reason: '运行环境检查', signal: abort.signal }, async () => {
      assert.fail('An owned approval must not reach the next provider');
    });
    try {
      await new Promise(setImmediate);
      const view = studio.publicTask(task);
      assert.equal(view.stage, '等待操作确认');
      assert.equal(view.pendingApprovals.length, 1);
      const approval = view.pendingApprovals[0];
      assert.equal(approval.toolName, 'pwsh');
      assert.equal(approval.reason, '运行环境检查');
      assert.equal(approval.complete, true);
      assert.deepEqual(JSON.parse(approval.details), args);
      assert.equal(saved(task).pendingApprovals, undefined);
      await assert.rejects(studio.approve(task.id, { approvalId: randomUUID(), decision: 'allowed-once' }), hasStatus(409));
      await assert.rejects(studio.approve(other.id, { approvalId: approval.id, decision: 'allowed-once' }), hasStatus(409));
      await assert.rejects(studio.approve(task.id, { approvalId: approval.id, decision: 'always-allow' }), hasStatus(400));
      assert.equal((await studio.approve(task.id, { approvalId: approval.id, decision: 'allowed-once' })).id, task.id);
      assert.equal(await outcome, 'allowed-once');
      assert.deepEqual(studio.publicTask(task).pendingApprovals, []);
      const replay = await studio.api('approval', new Request(`http://localhost/api/agent-motion/approval?id=${task.id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvalId: approval.id, decision: 'allowed-once' }),
      }));
      assert.equal(replay.status, 409);
    } finally {
      abort.abort(); await outcome;
      await studio.cancel(other.id); await studio.cancel(task.id);
    }
  });

  await t.test('withholds incomplete, oversized and credential-like arguments while permitting rejection', async () => {
    const task = await ready(); await execute(task);
    try {
      for (const args of [undefined, '', JSON.stringify({ command: 'x'.repeat(32001) }), JSON.stringify({ command: 'sk-' + 'x'.repeat(24) })]) {
        const callId = randomUUID();
        controller.sessions.get(task.sessionId).events = args === undefined ? [] : [
          { seq: 0, type: 'tool/call', data: { name: 'pwsh', callId, arguments: args } },
        ];
        const abort = new AbortController();
        const outcome = studio.requestApproval({ agent: { id: task.sessionId }, callId, toolName: 'pwsh', signal: abort.signal }, async () => assert.fail('Owned approval delegated'));
        try {
          await new Promise(setImmediate);
          const approval = studio.publicTask(task).pendingApprovals[0];
          assert.equal(approval.complete, false);
          assert.match(approval.details, /无法完整展示或可能包含凭据/);
          if (args) assert.ok(!approval.details.includes(args));
          await assert.rejects(studio.approve(task.id, { approvalId: approval.id, decision: 'allowed-once' }), hasStatus(409));
          await studio.approve(task.id, { approvalId: approval.id, decision: 'rejected' });
          assert.equal(await outcome, 'rejected');
          assert.deepEqual(studio.publicTask(task).pendingApprovals, []);
        } finally { abort.abort(); await outcome; }
      }
    } finally { await studio.cancel(task.id); }
  });

  await t.test('abort and disposal cancel pending approvals and retire their nonces', async () => {
    const task = await ready(); await execute(task);
    const callId = randomUUID();
    controller.sessions.get(task.sessionId).events = [
      { seq: 0, type: 'tool/call', data: { name: 'pwsh', callId, arguments: JSON.stringify({ command: 'node --version' }) } },
    ];
    const request = signal => ({ agent: { id: task.sessionId }, callId, toolName: 'pwsh', signal });
    const next = async () => assert.fail('Owned approval delegated');
    try {
      const alreadyAborted = new AbortController(); alreadyAborted.abort();
      assert.equal(await studio.requestApproval(request(alreadyAborted.signal), next), 'cancelled');
      assert.deepEqual(studio.publicTask(task).pendingApprovals, []);
      for (const dispose of [false, true]) {
        const abort = new AbortController();
        const outcome = studio.requestApproval(request(abort.signal), next);
        try {
          await new Promise(setImmediate);
          const approval = studio.publicTask(task).pendingApprovals[0];
          assert.ok(approval);
          if (dispose) studio.dispose(); else abort.abort();
          assert.equal(await outcome, 'cancelled');
          assert.deepEqual(studio.publicTask(task).pendingApprovals, []);
          await assert.rejects(studio.approve(task.id, { approvalId: approval.id, decision: 'allowed-once' }), hasStatus(409));
        } finally { abort.abort(); await outcome; }
      }
      await studio.cancel(task.id);
      assert.equal(await studio.requestApproval(request(new AbortController().signal), next), 'cancelled');
    } finally { await studio.cancel(task.id); }

    const raceController = mockController();
    const raceStudio = new Studio(path.join(temporary, 'dispose-during-inspection'), raceController, undefined, providers);
    const raceTask = await raceStudio.create(input);
    await raceStudio.upload(raceTask.id, uploadRequest());
    await executeAndWait(raceStudio, raceTask, raceController);
    const inspecting = deferred(), finishInspection = deferred();
    raceController.inspectHook = async () => { inspecting.resolve(); return finishInspection.promise; };
    const raceRequest = { agent: { id: raceTask.sessionId }, callId, toolName: 'pwsh' };
    const outcome = raceStudio.requestApproval(raceRequest, next);
    try {
      await inspecting.promise;
      raceStudio.dispose();
      finishInspection.resolve({ events: [{ type: 'tool/call', data: { name: 'pwsh', callId, arguments: JSON.stringify({ command: 'node --version' }) } }] });
      await new Promise(setImmediate);
      assert.deepEqual(raceStudio.publicTask(raceTask).pendingApprovals, []);
      assert.equal(await outcome, 'cancelled');
      const inspectCount = raceController.calls.filter(call => call.name === 'inspect').length;
      assert.equal(await raceStudio.requestApproval(raceRequest, next), 'cancelled');
      assert.equal(raceController.calls.filter(call => call.name === 'inspect').length, inspectCount);
    } finally {
      finishInspection.resolve({ events: [] }); raceStudio.dispose(); await outcome;
      await raceStudio.cancel(raceTask.id);
    }
  });

  await t.test('registers the production workspace before creating a session with workspaceId', async () => {
    // The disposal case above intentionally retired the prior host instance.
    studio = new Studio(storage, controller, undefined, providers);
    for (const created of [true, false]) {
      const sessionController = mockController(), order = [];
      const workspaceController = {
        async create(request) { order.push({ name: 'workspace/create', request }); return { workspace: { workspaceId: 'studio-workspace' }, created }; },
        async rename(request) { order.push({ name: 'workspace/rename', request }); },
      };
      sessionController.createHook = async () => { order.push({ name: 'session/create' }); };
      const workspaceStudio = new Studio(path.join(temporary, `workspace-${created}`), sessionController, workspaceController, providers);
      const task = await workspaceStudio.create(input);
      await workspaceStudio.upload(task.id, uploadRequest());
      try {
        await executeAndWait(workspaceStudio, task, sessionController);
        assert.deepEqual(order[0], { name: 'workspace/create', request: { path: workspaceStudio.workspace } });
        assert.deepEqual(order.map(call => call.name), created ? ['workspace/create', 'workspace/rename', 'session/create'] : ['workspace/create', 'session/create']);
        if (created) assert.deepEqual(order[1].request, { workspaceId: 'studio-workspace', title: 'Agent Motion 制作' });
        assert.deepEqual(sessionController.calls.find(call => call.name === 'create').request, { workspaceId: 'studio-workspace', agentPreset: 'standard' });
        assert.equal(sessionController.prompts.length, 1);
      } finally { workspaceStudio.dispose(); await workspaceStudio.cancel(task.id); }
    }
  });

  await t.test('reports actual execution phases without advancing on file reads or todo descriptions', async () => {
    const task = await ready(); await execute(task);
    const events = controller.sessions.get(task.sessionId).events;
    const call = (name, args) => events.push({ seq: events.length, type: 'tool/call', data: { name, callId: randomUUID(), arguments: JSON.stringify(args) } });
    call('pwsh', { command: 'node scripts/align-subtitles.mjs --video avatar.mp4' });
    assert.equal((await studio.status(task.id)).phase, 'subtitles');
    call('read', { file_path: 'scripts/render.mjs' });
    call('todo_write', { todos: [{ content: 'Run matte.mjs and render.mjs', status: 'pending' }] });
    assert.equal((await studio.status(task.id)).phase, 'subtitles');
    call('pwsh', { command: 'node scripts/matte.mjs --video avatar.mp4' });
    assert.equal((await studio.status(task.id)).phase, 'matte');
    call('pwsh', { command: 'node scripts/read-stage.mjs --stage animation --kind talking-head' });
    assert.equal((await studio.status(task.id)).phase, 'composition');
    call('pwsh', { command: 'node work/film/render.mjs' });
    assert.equal((await studio.status(task.id)).phase, 'export');
    await studio.cancel(task.id);
  });

  await t.test('produce stays in matting until its composition artifact exists and never resets rendering on reads', async () => {
    const task = await ready(); await execute(task);
    const events = controller.sessions.get(task.sessionId).events;
    const call = (name, args) => events.push({ seq: events.length, type: 'tool/call', data: { name, callId: randomUUID(), arguments: JSON.stringify(args) } });
    call('pwsh', { command: `node deepseek/lib/produce.js --output work/${task.id} --preview-only` });
    assert.equal((await studio.status(task.id)).phase, 'matte');
    const output = path.join(studio.workspace, 'work', task.id); mkdirSync(output);
    writeFileSync(path.join(output, 'film.json'), '{}');
    assert.equal((await studio.status(task.id)).phase, 'composition');
    assert.equal(saved(task).phase, 'composition');
    call('pwsh', { command: `node work/${task.id}/render.mjs` });
    assert.equal((await studio.status(task.id)).phase, 'export');
    call('read', { file_path: `work/${task.id}/film.json` });
    assert.equal((await studio.status(task.id)).phase, 'export');
    await studio.cancel(task.id);
  });

  await t.test('a new turn in the same event batch keeps the task running after the previous turn ended', async () => {
    const task = await ready(); await execute(task);
    controller.sessions.get(task.sessionId).events = [
      ...terminalEvents('completed', true),
      { seq: 4, type: 'turn/start', data: {} },
      { seq: 5, type: 'tool/call', data: { name: 'pwsh', callId: randomUUID(), arguments: JSON.stringify({ command: 'node scripts/align-subtitles.mjs --video voiced-avatar.mp4' }) } },
    ];
    assert.equal((await studio.status(task.id)).status, 'running');
    assert.equal(saved(task).status, 'running');
    assert.equal(studio.publicTask(task).result, undefined);
    await studio.cancel(task.id);
  });

  await t.test('removes only this task queued messages before admitting cancellation', async () => {
    const task = await ready({ ...input, subtitles: srt });
    await execute(task);
    assert.ok(controller.prompts.at(-1).content[0].text.includes('必须运行 node scripts/align-subtitles.mjs'));
    const inbox = controller.sessions.get(task.sessionId).inbox;
    const original = inbox['next-turn'][0].id;
    inbox['next-turn'].push({ id: 'unrelated', source: { kind: 'user', rpcId: randomUUID() } });
    inbox['next-step'].push({ id: 'same-task-next-step', source: { kind: 'user', rpcId: task.id } });
    const firstCall = controller.calls.length;
    assert.equal((await studio.cancel(task.id)).status, 'cancelled');
    const calls = controller.calls.slice(firstCall).filter(call => ['projections', 'updateQueue', 'cancel'].includes(call.name));
    assert.deepEqual(calls.map(call => call.name), ['projections', 'updateQueue', 'updateQueue', 'cancel']);
    assert.deepEqual(calls.filter(call => call.name === 'updateQueue').map(call => call.request.itemId).sort(), [original, 'same-task-next-step'].sort());
    assert.deepEqual(inbox['next-turn'].map(message => message.id), ['unrelated']);
    assert.deepEqual(inbox['next-step'], []);
    assert.equal(saved(task).status, 'cancelled');
  });

  await t.test('keeps stopping visible until cancellation succeeds and permits retry after failure', async () => {
    const task = await ready(); await execute(task);
    const admitted = deferred(), finish = deferred();
    controller.projectionHook = async () => { admitted.resolve(); await finish.promise; };
    const cancellation = studio.cancel(task.id);
    await admitted.promise;
    assert.equal((await studio.status(task.id)).status, 'stopping');
    assert.equal(saved(task).status, 'stopping');
    const other = await ready();
    await assert.rejects(execute(other), hasStatus(409));
    finish.resolve(); assert.equal((await cancellation).status, 'cancelled');
    controller.projectionHook = undefined;
    await execute(other);
    controller.cancelHook = () => { throw new Error('host cancellation unavailable'); };
    await assert.rejects(studio.cancel(other.id), /host cancellation unavailable/);
    assert.equal((await studio.status(other.id)).status, 'stopping');
    assert.equal(saved(other).status, 'stopping');
    controller.cancelHook = undefined;
    assert.equal((await studio.cancel(other.id)).status, 'cancelled');
  });

  await t.test('cancellation during session creation cannot subsequently queue a production prompt', async () => {
    const task = await ready();
    const entered = deferred(), finish = deferred();
    controller.createHook = async () => { entered.resolve(); await finish.promise; };
    const promptCount = controller.prompts.length;
    const execution = execute(task); await entered.promise;
    const cancellation = studio.cancel(task.id);
    // The status read is also a barrier for cancellation's initial persisted transition.
    assert.equal((await studio.status(task.id)).status, 'stopping');
    finish.resolve(); await Promise.all([execution, cancellation]);
    controller.createHook = undefined;
    assert.equal(controller.prompts.length, promptCount);
    assert.equal(task.status, 'cancelled');
    assert.ok(controller.calls.some(call => call.name === 'cancel' && call.request.sessionId === task.sessionId));
    assert.equal(saved(task).status, 'cancelled');
  });

  for (const [kind, skill, expected] of [['aborted', false, 'cancelled'], ['error', false, 'failed'], ['completed', false, 'failed'], ['completed', true, 'failed']]) {
    await t.test(`turn ${kind}, skill=${skill} never supplies results without validated artifacts`, async () => {
      const task = await ready(); await execute(task);
      controller.sessions.get(task.sessionId).events = terminalEvents(kind, skill);
      const status = await studio.status(task.id);
      assert.equal(status.status, expected);
      assert.equal(studio.publicTask(status).result, undefined);
      assert.equal(saved(task).status, expected);
      if (kind === 'completed' && !skill) assert.match(status.message, /没有成功加载/);
    });
  }

  await t.test('real H.264/AAC artifacts pass FFprobe while invalid duration and missing audio fail', async t => {
    const ffmpeg = mediaPath('ffmpeg'), ffprobe = mediaPath('ffprobe');
    for (const command of [ffmpeg, ffprobe]) {
      if (spawnSync(command, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).status !== 0) {
        t.skip('FFmpeg/FFprobe unavailable; portable task contracts still run'); return;
      }
    }
    const clip = path.join(temporary, 'encoded.mp4'), silentClip = path.join(temporary, 'silent.mp4');
    const encoded = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '0.2', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(encoded.status, 0, encoded.error?.message || encoded.stderr);
    const silent = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', clip, '-map', '0:v:0', '-c:v', 'copy', '-an', silentClip],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(silent.status, 0, silent.error?.message || silent.stderr);
    const previousProbe = process.env.FFPROBE_PATH;
    process.env.FFPROBE_PATH = ffprobe;
    try {
      for (const [source, duration, expected, hasAudio = true] of [[clip, 0.2, 'completed'], [clip, null, 'failed'], [silentClip, 0.2, 'failed'], [silentClip, 0.2, 'failed', false]]) {
        const task = await ready({ ...input, width: 1280, height: 720 }); await execute(task);
        const output = path.join(studio.workspace, 'work', task.id); mkdirSync(output);
        copyFileSync(source, path.join(output, 'final.mp4'));
        writeFileSync(path.join(output, 'index.html'), '<!doctype html><title>编码检查</title>');
        writeFileSync(path.join(output, 'film.json'), JSON.stringify({ width: 1280, height: 720, duration, hasAudio }));
        writeFileSync(path.join(output, 'validation.json'), '{}');
        controller.sessions.get(task.sessionId).events = terminalEvents('completed', true);
        const status = await studio.status(task.id);
        assert.equal(status.status, expected, status.message);
        const result = studio.publicTask(status).result;
        if (expected === 'completed') assert.deepEqual(result, {
          videoUrl: `/agent-motion/files/${task.id}/work/${task.id}/final.mp4`, previewUrl: `/agent-motion/files/${task.id}/work/${task.id}/index.html`,
          projectUrl: `/agent-motion/files/${task.id}/work/${task.id}/project.zip`,
        });
        else assert.equal(result, undefined);
      }
    } finally {
      if (previousProbe === undefined) delete process.env.FFPROBE_PATH;
      else process.env.FFPROBE_PATH = previousProbe;
    }
  });

  await t.test('serves only allowed task files, rejecting hidden paths and junction escapes', async () => {
    const task = await studio.create(input), other = await studio.create(input);
    const output = path.join(studio.workspace, 'work', task.id), otherOutput = path.join(studio.workspace, 'work', other.id);
    mkdirSync(output); mkdirSync(otherOutput);
    writeFileSync(path.join(output, 'index.html'), 'own preview');
    writeFileSync(path.join(otherOutput, 'index.html'), 'another task preview');
    assert.equal(await studio.file(task.id, `work/${task.id}/index.html`), realpathSync(path.join(output, 'index.html')));
    await assert.rejects(studio.file(task.id, `work/${task.id}/project.zip`), hasStatus(409));
    for (const relative of [`work/${other.id}/index.html`, `work/${task.id}/.secret`, `work/${task.id}/../index.html`,
      `work/${task.id}/frames/frame.png`, 'inputs/studio/source.mp4', 'node_modules/package.json', `work\\${task.id}\\index.html`]) {
      await assert.rejects(studio.file(task.id, relative), hasStatus(403));
    }
    await assert.rejects(studio.file('invalid-id', `work/${task.id}/index.html`), hasStatus(404));
    const outside = path.join(temporary, 'outside'); mkdirSync(outside); writeFileSync(path.join(outside, 'index.html'), 'outside workspace');
    for (const [name, target] of [['outside', outside], ['other-task', otherOutput]]) {
      const link = path.join(output, name);
      symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); links.push(link);
      await assert.rejects(studio.file(task.id, `work/${task.id}/${name}/index.html`), hasStatus(403));
    }
    assert.equal(readFileSync(path.join(outside, 'index.html'), 'utf8'), 'outside workspace');
    await studio.cancel(task.id); await studio.cancel(other.id);
  });

  await t.test('reload preserves uploaded input and reports interrupted active work without fabricated results', async () => {
    const active = await ready(); await execute(active);
    controller.sessions.get(active.sessionId).events = [{ seq: 0, type: 'turn/start', data: {} }];
    assert.equal((await studio.status(active.id)).status, 'running');
    const waiting = await studio.create(input);
    const restarted = new Studio(storage, controller, undefined, providers);
    const restored = await restarted.status(active.id);
    assert.equal(restored.status, 'failed');
    assert.match(restored.message, /服务重启/);
    assert.equal(restored.sessionId, active.sessionId);
    assert.equal(restarted.publicTask(restored).result, undefined);
    assert.equal((await restarted.status(waiting.id)).status, 'awaiting-upload');
    assert.deepEqual(readFileSync(path.join(studio.workspace, 'inputs', 'studio', active.id, 'source.mp4')), video);
    assert.equal(saved(active).status, 'failed');
  });
});
