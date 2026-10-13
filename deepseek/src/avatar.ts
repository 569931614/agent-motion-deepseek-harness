import { createReadStream } from 'node:fs';
import { access, link, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

const apiRoot = 'https://api.yidevs.com/app/human/human/Musetalk';
const fileLimit = 1024 ** 3, jsonLimit = 1024 ** 2;
const running = new Set<string>();
type Code = 'AVATAR_CONFIG' | 'AVATAR_INPUT' | 'AVATAR_BUSY' | 'AVATAR_UNCERTAIN' | 'AVATAR_CANCELLED' | 'AVATAR_TIMEOUT' | 'AVATAR_HTTP' | 'AVATAR_RESPONSE' | 'AVATAR_PROVIDER' | 'AVATAR_DOWNLOAD' | 'AVATAR_STORAGE';
export class AvatarError extends Error {
  constructor(readonly code: Code, message: string) { super(message); this.name = 'AvatarError'; }
}
interface CosConfiguration { endpoint: string; bucket: string; accessKeyId: string; accessKeySecret: string; securityToken?: string }
interface Configuration extends CosConfiguration { apiKey: string }
interface Source { path: string; object: string; bytes: number; sha256: string; contentType: string }
interface RecordFile {
  version: 1; requestId: string; status: 'prepared' | 'submission-uncertain' | 'processing' | 'downloading' | 'downloaded';
  video: Source; audio: Source; output: string; taskId?: string; billId?: string; file?: string;
}
/** Test seams replace transports or time; production callers omit this object. */
export interface AvatarInternals {
  fetch?: typeof fetch;
  put?: (url: URL, headers: Record<string, string>, source: string, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  timeoutMs?: number; requestTimeoutMs?: number; pollMs?: number;
}
export interface AvatarOptions {
  videoPath: string; audioPath: string; output: string; directory: string;
  /** Harness settings; when supplied, cloud credentials never fall back to process.env. */
  credentials?: NodeJS.ProcessEnv;
  signal?: AbortSignal; onStage?: (stage: string) => void | Promise<void>; internal?: AvatarInternals;
}
/** Only regional Tencent COS endpoints are supported; custom domains need separate signing. */
export function validateCosEndpoint(value: string): string {
  if (typeof value !== 'string' || /[\r\n]/.test(value) || !/^https:\/\/cos\.[a-z0-9]+(?:-[a-z0-9]+)+\.myqcloud\.com\/?$/i.test(value.trim())) throw new AvatarError('AVATAR_CONFIG', 'MOTION_OSS_ENDPOINT 应为腾讯云 COS 区域的 HTTPS 地址，例如 https://cos.ap-guangzhou.myqcloud.com。');
  return new URL(value.trim()).hostname;
}
/** COS API requests require the complete BucketName-APPID, not the console name alone. */
export function validateCosBucket(value: string): string {
  const bucket = typeof value === 'string' ? value.trim() : '';
  const match = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)-([0-9]+)$/.exec(bucket);
  if (!match || match[1].length > 50 || bucket.length > 63 || /[\r\n]/.test(value)) throw new AvatarError('AVATAR_CONFIG', 'MOTION_OSS_BUCKET 须为腾讯云 COS 完整存储桶名称（名称-APPID），名称仅含小写字母、数字和中划线且不超过 50 字符。');
  return bucket;
}
function cosConfiguration(env: NodeJS.ProcessEnv = process.env, fromSettings = env !== process.env): CosConfiguration {
  const labels: Record<string, string> = { MOTION_OSS_ENDPOINT: '腾讯云 COS Endpoint', MOTION_OSS_BUCKET: '腾讯云 COS Bucket', MOTION_OSS_ACCESS_KEY_ID: '腾讯云 COS SecretId', MOTION_OSS_ACCESS_KEY_SECRET: '腾讯云 COS SecretKey', MOTION_OSS_SECURITY_TOKEN: '腾讯云 COS SessionToken' };
  const friendly = (message: string) => message.replace(/MOTION_OSS_[A-Z_]+/g, field => labels[field] ?? field);
  const invalid = (message: string) => new AvatarError('AVATAR_CONFIG', fromSettings ? `请在 Harness 插件设置中修正配置：${friendly(message)}` : message);
  const fields = ['MOTION_OSS_ENDPOINT', 'MOTION_OSS_BUCKET', 'MOTION_OSS_ACCESS_KEY_ID', 'MOTION_OSS_ACCESS_KEY_SECRET'] as const;
  for (const field of fields) if (!env[field]?.trim() || /[\r\n]/.test(env[field]!)) throw new AvatarError('AVATAR_CONFIG', fromSettings ? `请在 Harness 插件设置中填写有效的 ${labels[field]}。` : `请在服务端设置有效的 ${field}。`);
  let endpoint: string, bucket: string;
  try { endpoint = validateCosEndpoint(env.MOTION_OSS_ENDPOINT!); bucket = validateCosBucket(env.MOTION_OSS_BUCKET!); }
  catch (error) { throw invalid(error instanceof AvatarError ? error.message : '腾讯云 COS 配置无效。'); }
  const accessKeyId = env.MOTION_OSS_ACCESS_KEY_ID!.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(accessKeyId)) throw invalid('MOTION_OSS_ACCESS_KEY_ID 格式无效。');
  const securityToken = env.MOTION_OSS_SECURITY_TOKEN?.trim() || undefined;
  if (securityToken && /[\r\n]/.test(securityToken)) throw invalid('MOTION_OSS_SECURITY_TOKEN 格式无效。');
  return { endpoint, bucket, accessKeyId, accessKeySecret: env.MOTION_OSS_ACCESS_KEY_SECRET!.trim(), securityToken };
}
function configuration(env: NodeJS.ProcessEnv = process.env, fromSettings = env !== process.env): Configuration {
  const apiKey = env.YIDEVS_API_KEY?.trim();
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new AvatarError('AVATAR_CONFIG', fromSettings ? '请在 Harness 插件设置中填写有效的 YIDEVS_API_KEY。' : '请在服务端设置有效的 YIDEVS_API_KEY。');
  return { ...cosConfiguration(env, fromSettings), apiKey };
}
export function configurationError(credentials?: NodeJS.ProcessEnv): string | undefined {
  try { configuration(credentials, credentials !== undefined); return undefined; } catch (error) { return error instanceof AvatarError ? error.message : '数字人服务配置无效。'; }
}
export function avatarConfigured(credentials?: NodeJS.ProcessEnv): boolean { return configurationError(credentials) === undefined; }
function check(signal: AbortSignal, deadline: number, now: () => number): void {
  if (signal.aborted) throw new AvatarError('AVATAR_CANCELLED', '数字人任务已停止；有任务编号时可继续查询，不会重新提交。');
  if (now() >= deadline) throw new AvatarError('AVATAR_TIMEOUT', '数字人处理超时；请续查当前任务，避免重复付费提交。');
}
function scopedSignal(signal: AbortSignal, deadline: number, now: () => number, timeout: number): AbortSignal {
  check(signal, deadline, now);
  return AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(timeout, deadline - now()))))]);
}
function encode(value: string): string { return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`); }
function objectUrl(config: CosConfiguration, object: string): URL {
  return new URL(`https://${config.bucket}.${config.endpoint}/${object.split('/').map(encode).join('/')}`);
}
function canonical(values: Record<string, string>): { list: string; text: string } {
  const entries = Object.entries(values).map(([key, value]) => [encode(key).toLowerCase(), encode(value)]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return { list: entries.map(([key]) => key).join(';'), text: entries.map(([key, value]) => `${key}=${value}`).join('&') };
}
/** Tencent COS V5: the hexadecimal SignKey is the key for the second HMAC. */
function authorization(config: CosConfiguration, method: string, object: string, headers: Record<string, string>, query: Record<string, string>, now: number, seconds: number): string {
  const start = Math.floor(now / 1000) - 1, keyTime = `${start};${start + seconds}`;
  const header = canonical(headers), parameters = canonical(query);
  const httpString = `${method.toLowerCase()}\n/${object}\n${parameters.text}\n${header.text}\n`;
  const signKey = createHmac('sha1', config.accessKeySecret).update(keyTime).digest('hex');
  const stringToSign = `sha1\n${keyTime}\n${createHash('sha1').update(httpString).digest('hex')}\n`;
  const signed = createHmac('sha1', signKey).update(stringToSign).digest('hex');
  return `q-sign-algorithm=sha1&q-ak=${config.accessKeyId}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=${header.list}&q-url-param-list=${parameters.list}&q-signature=${signed}`;
}
function uploadHeaders(config: CosConfiguration, source: Source, now: number): Record<string, string> {
  const signedHeaders: Record<string, string> = { host: objectUrl(config, source.object).hostname, 'content-type': source.contentType, 'content-length': String(source.bytes), 'x-cos-acl': 'private', ...(config.securityToken ? { 'x-cos-security-token': config.securityToken } : {}) };
  // Date is sent for diagnostics; the official SDK signs host/content headers and x-cos-*.
  return { Date: new Date(now).toUTCString(), ...signedHeaders, Authorization: authorization(config, 'PUT', source.object, signedHeaders, {}, now, 900) };
}
function signedGet(config: CosConfiguration, source: Source, now: number): string {
  const url = objectUrl(config, source.object), query: Record<string, string> = config.securityToken ? { 'x-cos-security-token': config.securityToken } : {};
  const signed = authorization(config, 'GET', source.object, { host: url.hostname }, query, now, 3 * 60 * 60);
  // RFC 3986 encodes tokens once while signing their decoded values.
  url.search = `?${signed}${config.securityToken ? `&x-cos-security-token=${encode(config.securityToken)}` : ''}`;
  return url.href;
}
async function putObject(url: URL, headers: Record<string, string>, source: string, signal: AbortSignal): Promise<void> {
  const body = createReadStream(source);
  const request = httpsRequest(url, { method: 'PUT', headers, signal });
  const response = new Promise<void>((resolve, reject) => {
    request.once('error', reject);
    request.once('response', reply => {
      const status = reply.statusCode ?? 0;
      // Do not buffer or expose COS error bodies, which can contain signed requests.
      reply.resume(); reply.once('error', reject);
      reply.once('end', () => status >= 200 && status < 300 ? resolve() : reject(new AvatarError('AVATAR_STORAGE', `数字人素材上传失败（HTTP ${status}）。`)));
    });
  });
  try { await Promise.all([pipeline(body, request, { signal }), response]); }
  finally { body.destroy(); request.destroy(); }
}
async function boundedBody(response: Response, signal: AbortSignal): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > jsonLimit) { await response.body?.cancel(); throw new AvatarError('AVATAR_RESPONSE', '数字人服务响应过大，已停止读取。'); }
  if (!response.body) throw new AvatarError('AVATAR_RESPONSE', '数字人服务返回了空响应。');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted();
      if (part.done) break;
      size += part.value.length;
      if (size > jsonLimit) throw new AvatarError('AVATAR_RESPONSE', '数字人服务响应过大，已停止读取。');
      chunks.push(part.value);
    }
    return Buffer.concat(chunks, size);
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}
async function api(config: Configuration, route: string, network: typeof fetch, signal: AbortSignal, payload?: object): Promise<Record<string, any>> {
  const response = await network(apiRoot + route, { method: payload ? 'POST' : 'GET', redirect: 'error', signal,
    headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(payload ? { body: JSON.stringify(payload) } : {}) });
  if (!response.ok) { await response.body?.cancel(); throw new AvatarError('AVATAR_HTTP', `数字人服务请求失败（HTTP ${response.status}）；请续查已保存的任务。`); }
  let reply;
  try { reply = JSON.parse((await boundedBody(response, signal)).toString('utf8')); }
  catch (error) { if (error instanceof AvatarError || signal.aborted) throw error; throw new AvatarError('AVATAR_RESPONSE', '数字人服务返回无效 JSON，响应内容未保存。'); }
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new AvatarError('AVATAR_RESPONSE', '数字人服务返回无效响应。');
  if (reply.code !== 200) throw new AvatarError('AVATAR_PROVIDER', '数字人服务返回失败代码，请检查供应商控制台；未重复提交。');
  if (!reply.data || typeof reply.data !== 'object' || Array.isArray(reply.data)) throw new AvatarError('AVATAR_RESPONSE', '数字人服务缺少任务数据。');
  return reply.data;
}
function validId(value: unknown, secrets: string[]): string | undefined {
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim() || String(value).length > 256 || /[\r\n\0]/.test(String(value)) || secrets.some(secret => String(value).includes(secret))) return undefined;
  return String(value);
}
async function source(filename: string, object: string, contentType: string, signal: AbortSignal, deadline: number, now: () => number): Promise<Source> {
  const canonical = await realpath(path.resolve(filename)); const info = await stat(canonical);
  if (!info.isFile() || info.size <= 0 || info.size > fileLimit) throw new AvatarError('AVATAR_INPUT', '数字人素材应为非空文件，单个文件不能超过 1 GiB。');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(canonical, { signal })) { check(signal, deadline, now); hash.update(chunk); }
  check(signal, deadline, now);
  return { path: canonical, object, bytes: info.size, sha256: hash.digest('hex'), contentType };
}
export interface PrivateMediaOptions {
  filePath: string; objectKey: string; contentType: string; signal?: AbortSignal;
  credentials?: NodeJS.ProcessEnv;
  /** Test seams; production callers use the streaming HTTPS uploader. */
  internal?: Pick<AvatarInternals, 'put' | 'now' | 'requestTimeoutMs'>;
}
/** Upload a private media object; keep the returned three-hour URL in memory only. */
export async function uploadPrivateMedia(options: PrivateMediaOptions): Promise<string> {
  const config = cosConfiguration(options.credentials, options.credentials !== undefined), internal = options.internal ?? {}, now = internal.now ?? Date.now;
  const timeout = internal.requestTimeoutMs ?? 90000;
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 90000) throw new AvatarError('AVATAR_INPUT', '媒体上传超时参数无效。');
  if (typeof options.objectKey !== 'string' || Buffer.byteLength(options.objectKey) > 1024 || /[\u0000-\u001f\u007f\\?#%]/u.test(options.objectKey) || [...options.objectKey].some(character => /^[\uD800-\uDFFF]$/.test(character)) || options.objectKey.split('/').some(part => !part || part === '.' || part === '..')) throw new AvatarError('AVATAR_INPUT', '媒体 COS 对象名称无效。');
  if (typeof options.contentType !== 'string' || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(options.contentType)) throw new AvatarError('AVATAR_INPUT', '媒体类型无效。');
  const signal = options.signal ?? new AbortController().signal, deadline = now() + timeout;
  const scoped = scopedSignal(signal, deadline, now, timeout);
  try {
    const media = await source(options.filePath, options.objectKey, options.contentType, scoped, deadline, now);
    await (internal.put ?? putObject)(objectUrl(config, media.object), uploadHeaders(config, media, now()), media.path, scoped);
    scoped.throwIfAborted(); check(signal, deadline, now);
    return signedGet(config, media, now());
  } catch (error) {
    if (signal.aborted) throw new AvatarError('AVATAR_CANCELLED', '媒体上传已停止。');
    if (scoped.aborted || now() >= deadline || (error as Error)?.name === 'TimeoutError') throw new AvatarError('AVATAR_TIMEOUT', '媒体上传超时。');
    if (error instanceof AvatarError) throw error;
    // Transport and filesystem errors may contain credentials or signed URLs.
    throw new AvatarError('AVATAR_STORAGE', options.credentials !== undefined ? '媒体上传失败，请检查 Harness 插件设置中的腾讯云 COS 配置和素材文件。' : '媒体上传失败，请检查服务端腾讯云 COS 配置和素材文件。');
  }
}
function within(directory: string, filename: string): boolean {
  const relative = path.relative(directory, filename);
  return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function save(filename: string, value: RecordFile): Promise<void> {
  const pending = `${filename}.${randomUUID()}.tmp`;
  try { await writeFile(pending, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(pending, filename); }
  finally { await unlink(pending).catch(() => {}); }
}
async function load(filename: string): Promise<RecordFile | undefined> {
  let info;
  try { info = await stat(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!info.isFile() || info.size > jsonLimit || await realpath(filename) !== filename) throw new AvatarError('AVATAR_INPUT', '数字人任务记录无效。');
  let record;
  try { record = JSON.parse(await readFile(filename, 'utf8')); } catch { throw new AvatarError('AVATAR_INPUT', '数字人任务记录无法读取，请保留目录并检查已有任务。'); }
  if (record?.version !== 1 || typeof record.requestId !== 'string' || !['prepared', 'submission-uncertain', 'processing', 'downloading', 'downloaded'].includes(record.status) || !record.video || !record.audio || typeof record.output !== 'string' || (record.taskId !== undefined && !validId(record.taskId, []))) throw new AvatarError('AVATAR_INPUT', '数字人任务记录无效，请勿重新提交可能已收费的请求。');
  return record;
}
async function lock(directory: string): Promise<() => Promise<void>> {
  if (running.has(directory)) throw new AvatarError('AVATAR_BUSY', '这个数字人任务正在处理，请等待或续查。');
  running.add(directory); const filename = path.join(directory, 'avatar-request.lock'), owner = randomUUID();
  try {
    let handle;
    try { handle = await open(filename, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await stat(filename);
      if (!info.isFile() || info.size > 1024 || await realpath(filename) !== filename) throw new AvatarError('AVATAR_BUSY', '数字人任务锁无效，请检查任务目录。');
      let held;
      try { held = JSON.parse(await readFile(filename, 'utf8')); } catch { throw new AvatarError('AVATAR_BUSY', '数字人任务已有处理者，请等待。'); }
      if (!Number.isInteger(held.pid) || held.pid <= 0) throw new AvatarError('AVATAR_BUSY', '数字人任务锁无效。');
      // Reclaiming a stale lock by unlinking it can delete another process's newly
      // acquired lock. Keep every existing lock until an operator confirms its
      // owner has stopped, preserving the record before manual lock removal.
      throw new AvatarError('AVATAR_BUSY', '数字人任务已有处理锁，请等待；若进程已停止，请保留 avatar-request.json，确认没有处理者后手动移除 avatar-request.lock 再续查。');
    }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, owner })); } finally { await handle.close(); }
    return async () => {
      try { if (JSON.parse(await readFile(filename, 'utf8')).owner === owner) await unlink(filename); } finally { running.delete(directory); }
    };
  } catch (error) { running.delete(directory); throw error; }
}
function downloadUrl(value: unknown, secrets: string[]): URL {
  if (typeof value !== 'string' || value.length > 16384 || secrets.some(secret => value.includes(secret))) throw new AvatarError('AVATAR_DOWNLOAD', '数字人结果地址无效。');
  let url;
  try { url = new URL(value); } catch { throw new AvatarError('AVATAR_DOWNLOAD', '数字人结果地址无效。'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new AvatarError('AVATAR_DOWNLOAD', '数字人结果下载只允许不含内嵌凭据的 HTTPS 地址。');
  return url;
}
async function validVideo(filename: string): Promise<void> {
  const info = await stat(filename);
  if (!info.isFile() || info.size < 16 || info.size > fileLimit) throw new AvatarError('AVATAR_DOWNLOAD', '数字人结果不是有效的 MP4 文件。');
  const handle = await open(filename, 'r'); const header = Buffer.alloc(16);
  try { await handle.read(header, 0, 16, 0); } finally { await handle.close(); }
  if (header.toString('ascii', 4, 8) !== 'ftyp') throw new AvatarError('AVATAR_DOWNLOAD', '数字人结果不是可识别的 MP4 文件。');
}
async function download(url: URL, output: string, network: typeof fetch, signal: AbortSignal, deadline: number, now: () => number, timeout: number, secrets: string[]): Promise<void> {
  for (let redirects = 0; redirects <= 5; redirects++) {
    const scoped = scopedSignal(signal, deadline, now, timeout);
    const response = await network(url, { redirect: 'manual', signal: scoped }); // No API or OSS Authorization travels to the result server.
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get('location'); await response.body?.cancel();
      if (!next) throw new AvatarError('AVATAR_DOWNLOAD', '数字人结果重定向缺少地址。');
      url = downloadUrl(new URL(next, url).href, secrets); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new AvatarError('AVATAR_DOWNLOAD', `数字人结果下载失败（HTTP ${response.status}）；可续查当前任务。`); }
    if (Number(response.headers.get('content-length')) > fileLimit) { await response.body?.cancel(); throw new AvatarError('AVATAR_DOWNLOAD', '数字人结果超过 1 GiB，已停止下载。'); }
    if (!response.body) throw new AvatarError('AVATAR_DOWNLOAD', '数字人结果下载为空。');
    const pending = `${output}.${randomUUID()}.pending`, reader = response.body.getReader();
    const abort = () => { void reader.cancel().catch(() => {}); }; let size = 0;
    scoped.addEventListener('abort', abort, { once: true });
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(pending, 'wx', 0o600);
      for (;;) {
        scoped.throwIfAborted(); const part = await reader.read(); scoped.throwIfAborted();
        if (part.done) break;
        size += part.value.length;
        if (size > fileLimit) throw new AvatarError('AVATAR_DOWNLOAD', '数字人结果超过 1 GiB，已停止下载。');
        await handle.writeFile(part.value);
      }
      await handle.close(); await validVideo(pending); check(signal, deadline, now);
      if (await access(output).then(() => true, () => false)) throw new AvatarError('AVATAR_INPUT', '数字人成片已存在，不会覆盖。');
      // A hard link installs the completed file atomically and refuses an existing destination.
      try { await link(pending, output); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AvatarError('AVATAR_INPUT', '数字人成片已存在，不会覆盖。'); throw error; }
      return;
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { scoped.removeEventListener('abort', abort); reader.releaseLock(); await handle?.close().catch(() => {}); await unlink(pending).catch(() => {}); }
  }
  throw new AvatarError('AVATAR_DOWNLOAD', '数字人结果重定向次数过多。');
}

/** Upload private sources, submit one paid request, and resume by saved task ID. */
export async function generateAvatar(options: AvatarOptions): Promise<{ videoPath: string; taskId: string }> {
  const config = configuration(options.credentials, options.credentials !== undefined), internal = options.internal ?? {}, network = internal.fetch ?? fetch;
  const now = internal.now ?? Date.now, wait = internal.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  const timeout = internal.timeoutMs ?? 3600000, requestTimeout = internal.requestTimeoutMs ?? 90000, poll = internal.pollMs ?? 10000;
  if (![timeout, requestTimeout, poll].every(value => Number.isInteger(value) && value > 0) || timeout > 3600000 || requestTimeout > 90000 || poll > 10000) throw new AvatarError('AVATAR_INPUT', '数字人请求超时参数无效。');
  const signal = options.signal ?? new AbortController().signal, deadline = now() + timeout;
  check(signal, deadline, now);
  await mkdir(path.resolve(options.directory), { recursive: true });
  const directory = await realpath(path.resolve(options.directory)), output = path.resolve(options.output);
  if (!within(directory, output) || await realpath(path.dirname(output)) !== path.dirname(output)) throw new AvatarError('AVATAR_INPUT', '数字人成片必须位于本任务目录内。');
  const release = await lock(directory);
  const credentials = options.credentials ?? process.env;
  const secrets = [config.apiKey, config.accessKeyId, config.accessKeySecret, config.securityToken, credentials.DASHSCOPE_API_KEY, credentials.AA_API_KEY].filter((value): value is string => !!value);
  const stage = async (value: string) => { await options.onStage?.(value); check(signal, deadline, now); };
  try {
    const filename = path.join(directory, 'avatar-request.json'); let record = await load(filename);
    if (record?.taskId && !validId(record.taskId, secrets)) throw new AvatarError('AVATAR_INPUT', '数字人任务编号无效，请保留当前任务目录。');
    if (record && (record.output !== path.relative(directory, output) || path.resolve(record.video.path) !== path.resolve(options.videoPath) || path.resolve(record.audio.path) !== path.resolve(options.audioPath))) throw new AvatarError('AVATAR_INPUT', '当前目录已有不同的数字人任务，请保留并续查原任务。');
    if (record && !record.taskId && record.status !== 'prepared') throw new AvatarError('AVATAR_UNCERTAIN', '上次付费提交结果不确定且未保存任务编号，请先检查供应商控制台；不会自动重新提交。');
    if (record?.taskId && await access(output).then(() => true, () => false)) {
      if (!['downloaded', 'downloading'].includes(record.status) || record.file !== path.relative(directory, output) || await realpath(output) !== output) throw new AvatarError('AVATAR_INPUT', '数字人成片已存在，不会覆盖。');
      await validVideo(output); record.status = 'downloaded'; await save(filename, record); return { videoPath: output, taskId: record.taskId };
    }
    if (!record?.taskId) {
      if (await access(output).then(() => true, () => false)) throw new AvatarError('AVATAR_INPUT', '数字人成片已存在，不会覆盖。');
      const videoType = ({ '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mpeg': 'video/mpeg' } as Record<string, string>)[path.extname(options.videoPath).toLowerCase()];
      const audioType = ({ '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4' } as Record<string, string>)[path.extname(options.audioPath).toLowerCase()];
      if (!videoType || !audioType) throw new AvatarError('AVATAR_INPUT', '请选择 MP4/MOV/MPEG 人物视频和 MP3/WAV/M4A 音频。');
      const requestId = record?.requestId ?? randomUUID(), prefix = `agent-motion/avatar/${requestId}`;
      const video = await source(options.videoPath, `${prefix}/source${path.extname(options.videoPath).toLowerCase()}`, videoType, signal, deadline, now);
      const audio = await source(options.audioPath, `${prefix}/audio${path.extname(options.audioPath).toLowerCase()}`, audioType, signal, deadline, now);
      if (record && (record.video.sha256 !== video.sha256 || record.audio.sha256 !== audio.sha256)) throw new AvatarError('AVATAR_INPUT', '数字人素材已变化，请使用新任务目录。');
      record = { version: 1, requestId, status: 'prepared', video, audio, output: path.relative(directory, output) }; await save(filename, record);
      await stage('正在上传人物视频'); await (internal.put ?? putObject)(objectUrl(config, video.object), uploadHeaders(config, video, now()), video.path, scopedSignal(signal, deadline, now, requestTimeout));
      await stage('正在上传配音音频'); await (internal.put ?? putObject)(objectUrl(config, audio.object), uploadHeaders(config, audio, now()), audio.path, scopedSignal(signal, deadline, now, requestTimeout));
      check(signal, deadline, now); record.status = 'submission-uncertain'; await save(filename, record);
      await stage('正在提交数字人合成');
      const reply = await api(config, '/direct', network, scopedSignal(signal, deadline, now, requestTimeout), { video_url: signedGet(config, video, now()), audio_url: signedGet(config, audio, now()) });
      const taskId = validId(reply.video_task_id, secrets);
      if (!taskId) throw new AvatarError('AVATAR_UNCERTAIN', '数字人服务没有返回有效任务编号，请检查供应商控制台；不会自动重新提交。');
      record.taskId = taskId; record.billId = validId(reply.bill_id, secrets); record.status = 'processing'; await save(filename, record);
    }
    const task = record!; const taskId = task.taskId!;
    await stage('数字人正在合成，可续查当前任务');
    for (;;) {
      check(signal, deadline, now);
      const reply = await api(config, `/task?task_id=${encodeURIComponent(taskId)}`, network, scopedSignal(signal, deadline, now, requestTimeout));
      if (reply.state === 20) {
        if (typeof reply.videoUrl === 'string' && reply.videoUrl) {
          const url = downloadUrl(reply.videoUrl, secrets);
          task.status = 'downloading'; task.file = path.relative(directory, output); await save(filename, task); await stage('正在下载数字人成片');
          await download(url, output, network, signal, deadline, now, requestTimeout, secrets);
          task.status = 'downloaded'; await save(filename, task); await stage('数字人成片已就绪');
          return { videoPath: output, taskId };
        }
        await stage('合成已完成，正在等待成片地址');
      }
      check(signal, deadline, now); await wait(Math.min(poll, deadline - now()), signal);
    }
  } catch (error) {
    if (signal.aborted) throw new AvatarError('AVATAR_CANCELLED', '数字人任务已停止；有任务编号时可继续查询，不会重新提交。');
    if (error instanceof AvatarError) throw error;
    if ((error as Error)?.name === 'TimeoutError' || now() >= deadline) throw new AvatarError('AVATAR_TIMEOUT', '数字人请求超时；请续查当前任务，避免重复付费提交。');
    // Never forward upstream error messages, request headers, signed URLs or response bodies.
    throw new AvatarError('AVATAR_HTTP', '数字人网络或文件操作失败；请保留当前任务目录并续查，不会自动重新提交。');
  } finally { await release().catch(() => {}); }
}
