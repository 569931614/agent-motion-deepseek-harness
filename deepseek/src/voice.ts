import { closeSync, existsSync, fsyncSync, linkSync, openSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import WebSocket from 'ws';

const endpoint = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
const model = 'cosyvoice-v3.5-plus';
const handshakeTimeout = 30000;
const overallTimeout = 30 * 60 * 1000;
const audioLimit = 512 * 1024 * 1024;

export interface VoiceOptions {
  text: string;
  voice: string;
  /** The existing task directory supplied by the trusted Studio caller. */
  directory: string;
  /** A new .wav file inside this task directory; its parent must exist. */
  output: string;
  /** Harness settings; when supplied, cloud credentials never fall back to process.env. */
  credentials?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Persist submission-uncertain state before the potentially charged run-task. */
  onSubmitted?: () => void | Promise<void>;
}

/** Submit one Beijing CosyVoice task; a disconnect never creates another paid task. */
export async function synthesizeVoice(options: VoiceOptions): Promise<{ audioPath: string }> {
  if (options.signal?.aborted) throw new Error('Voice request cancelled before submission.');
  if (typeof options.text !== 'string' || !options.text.trim()) throw new Error('Provide nonempty voice text.');
  const characters = [...options.text];
  if (characters.length > 50000) throw new Error('Voice text must not exceed 50000 characters.');
  if (characters.some(character => /^[\uD800-\uDFFF]$/.test(character))) throw new Error('Voice text contains invalid Unicode.');
  if (typeof options.voice !== 'string' || !options.voice || options.voice.length > 256 || /\s|[\u0000-\u001f\u007f]/u.test(options.voice)) throw new Error('Provide a valid custom voice ID created for cosyvoice-v3.5-plus; there is no system voice default.');
  const key = (options.credentials ?? process.env).DASHSCOPE_API_KEY?.trim();
  if (!key || /[\r\n]/.test(key)) throw new Error(options.credentials !== undefined ? '请在 Harness 插件设置中填写北京地域 DASHSCOPE_API_KEY。' : 'Set a Beijing DASHSCOPE_API_KEY in the Node environment.');
  if (typeof options.directory !== 'string' || !options.directory.trim()) throw new Error('Provide the existing voice task directory.');
  const directory = realpathSync(options.directory);
  if (!statSync(directory).isDirectory()) throw new Error('Voice task directory must be a directory.');
  if (typeof options.output !== 'string' || path.extname(options.output).toLowerCase() !== '.wav') throw new Error('Voice output must be a new .wav file.');
  const target = path.resolve(options.output);
  const parent = realpathSync(path.dirname(target));
  const audioPath = path.join(parent, path.basename(target));
  const relative = path.relative(directory, audioPath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Voice output must be inside its task directory.');
  if (existsSync(audioPath)) throw new Error('Voice output already exists; existing audio is never overwritten.');
  const temporary = path.join(parent, `.voice-${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, 'wx+');
  try { if (writeSync(descriptor, Buffer.alloc(44)) !== 44) throw new Error('WAV header reservation was incomplete.'); }
  catch {
    try { closeSync(descriptor); } finally { unlinkSync(temporary); }
    throw new Error('Voice audio could not be prepared; no task was sent.');
  }
  const taskId = randomUUID();
  const message = (action: string, payload: object) => JSON.stringify({ header: { action, task_id: taskId, streaming: 'duplex' }, payload });
  let socket: WebSocket | undefined;
  let closed = false;
  let submitted = false;
  let stage: 'connecting' | 'recording' | 'starting' | 'streaming' | 'finishing' = 'connecting';
  let bytes = 0;
  let done = false;

  return new Promise<{ audioPath: string }>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', abort);
      socket?.terminate();
      if (!closed) { try { closeSync(descriptor); } catch { /* Always attempt temporary-file cleanup. */ } closed = true; }
      try { unlinkSync(temporary); } catch { /* The complete file may already have been published. */ }
    };
    const fail = (error: Error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(error);
    };
    const abort = () => {
      if (done) return;
      // Cancellation is best effort after submission; it never authorizes a retry.
      if (submitted && socket?.readyState === WebSocket.OPEN) {
        try { socket.send(message('finish-task', { input: { directive: 'cancel' } })); } catch { /* Close below even if cancellation cannot be sent. */ }
      }
      fail(new Error(submitted ? 'Voice request cancelled; the submitted task was not retried.' : 'Voice request cancelled before submission.'));
    };
    const deadline = setTimeout(() => fail(new Error('Voice request timed out; no task was automatically retried.')), overallTimeout);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }

    const send = (action: string, payload: object): Promise<void> => new Promise((sent, failed) => {
      if (done || options.signal?.aborted || socket?.readyState !== WebSocket.OPEN) { failed(new Error('Voice connection ended; no task was automatically retried.')); return; }
      socket.send(message(action, payload), error => error ? failed(new Error('Voice connection could not send data; no task was automatically retried.')) : sent());
    });
    const begin = async () => {
      if (done || options.signal?.aborted) { abort(); return; }
      stage = 'recording';
      try { await options.onSubmitted?.(); }
      catch { fail(new Error('Voice submission state could not be saved; no voice task was sent.')); return; }
      if (done || options.signal?.aborted) { abort(); return; }
      stage = 'starting';
      submitted = true; // A send failure can still leave submission uncertain.
      await send('run-task', {
        task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model,
        parameters: { text_type: 'PlainText', voice: options.voice, format: 'pcm', sample_rate: 24000, volume: 50, rate: 1.0, pitch: 1.0 },
        input: {},
      });
    };
    const streamText = async () => {
      stage = 'streaming';
      for (let index = 0; index < characters.length; index += 20000) {
        await send('continue-task', { input: { text: characters.slice(index, index + 20000).join('') } });
      }
      if (done || options.signal?.aborted) return;
      stage = 'finishing';
      await send('finish-task', { input: {} });
    };
    const finish = () => {
      if (options.signal?.aborted) { abort(); return; }
      if (!bytes || bytes % 2 !== 0) {
        fail(new Error('CosyVoice did not return a complete 16-bit PCM audio stream.')); return;
      }
      try {
        // The documented PCM stream is signed 16-bit little-endian mono. A final
        // WAV header records the actual length instead of an unknown stream length.
        const header = Buffer.alloc(44);
        header.write('RIFF'); header.writeUInt32LE(36 + bytes, 4); header.write('WAVE', 8);
        header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
        header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
        header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(bytes, 40);
        if (writeSync(descriptor, header, 0, header.length, 0) !== header.length) throw new Error('WAV header write was incomplete.');
        fsyncSync(descriptor);
        closeSync(descriptor); closed = true;
        // Publishing by hard link is atomic and refuses an existing output file.
        linkSync(temporary, audioPath);
      } catch { fail(new Error('Voice audio could not be saved; existing audio was preserved.')); return; }
      done = true;
      cleanup();
      resolve({ audioPath });
    };

    try {
      socket = new WebSocket(endpoint, {
        headers: { Authorization: `Bearer ${key}` },
        handshakeTimeout, followRedirects: false, maxPayload: 1024 * 1024,
      });
      socket.on('open', () => { void begin().catch(fail); });
      socket.on('unexpected-response', (_request, response) => {
        response.destroy();
        fail(new Error(`CosyVoice WebSocket handshake HTTP ${response.statusCode ?? 'error'}; no task was automatically retried.`));
      });
      socket.on('error', error => fail(new Error(error.message === 'Opening handshake has timed out'
        ? 'CosyVoice WebSocket handshake timed out; no task was sent.'
        : 'CosyVoice connection failed; no task was automatically retried.')));
      socket.on('close', () => fail(new Error('CosyVoice disconnected before completion; no task was automatically retried.')));
      socket.on('message', (data, isBinary) => {
        if (done) return;
        if (options.signal?.aborted) { abort(); return; }
        if (isBinary) {
          if (stage !== 'streaming' && stage !== 'finishing') { fail(new Error('CosyVoice sent audio before the task was started.')); return; }
          const chunk = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
          if (bytes + chunk.length > audioLimit) { fail(new Error('Voice audio exceeds the 512 MiB output limit.')); return; }
          try {
            let offset = 0;
            while (offset < chunk.length) {
              const written = writeSync(descriptor, chunk, offset, chunk.length - offset);
              if (written <= 0) throw new Error('Audio write made no progress.');
              offset += written;
            }
            bytes += chunk.length;
          } catch { fail(new Error('Voice audio could not be written; the task was not retried.')); }
          return;
        }
        let event: { header?: { task_id?: unknown; event?: unknown; error_code?: unknown } };
        try { event = JSON.parse(data.toString()); }
        catch { fail(new Error('CosyVoice returned invalid JSON; the provider response was not logged.')); return; }
        if (event?.header?.task_id !== taskId) { fail(new Error('CosyVoice returned an unexpected task ID.')); return; }
        switch (event.header.event) {
          case 'task-started':
            if (stage !== 'starting') { fail(new Error('CosyVoice sent an unexpected task-started event.')); return; }
            void streamText().catch(fail);
            break;
          case 'result-generated':
            if (stage !== 'streaming' && stage !== 'finishing') fail(new Error('CosyVoice sent a result before the task was started.'));
            break;
          case 'task-finished':
            if (stage !== 'finishing') { fail(new Error('CosyVoice finished before all text was sent.')); return; }
            finish();
            break;
          case 'task-failed': {
            // Provider messages can echo secrets or user text. Only known error names leave this module.
            const known = ['InvalidParameter', 'InvalidApiKey', 'AccessDenied', 'ModelNotFound', 'Throttling', 'RateLimit', 'InternalError', 'ServiceUnavailable'];
            const code = typeof event.header.error_code === 'string' && known.includes(event.header.error_code) ? ` (${event.header.error_code})` : '';
            fail(new Error(options.credentials !== undefined ? `CosyVoice task failed${code}; 请检查 Harness 插件设置中的北京地域密钥、模型和自定义音色编号。The task was not retried.` : `CosyVoice task failed${code}; verify the Beijing key, model and custom voice ID. The task was not retried.`));
            break;
          }
          default: fail(new Error('CosyVoice returned an unsupported event; the provider response was not logged.'));
        }
      });
    } catch { fail(new Error('CosyVoice connection could not be opened; no task was sent.')); }
  });
}
