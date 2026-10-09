import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { mediaPath } from '../../scripts/media-tools.mjs';

const endpoint = 'https://api.aa.com.cn/api/v1';
const root = fileURLToPath(new URL('../../', import.meta.url));
const models = ['doubao-seedream-4-0-250828', 'doubao-seedream-4-5-251128', 'doubao-seedream-5-0-260128'];
const imageLimit = 64 * 1024 * 1024;
interface Task { model: string; size: string; maxImages: number; status: string; taskId?: string; requestId?: string; urls?: string[]; usage?: unknown; expired?: string; files?: string[] }
interface Reply { code: number; data: { urls?: string[]; task_id?: string; task_status?: string; usage?: unknown; expired?: string }; request_id?: string }
export interface ImageOptions { output: string; prompt?: string; model?: string; size?: string; references?: string[]; maxImages?: number; watermark?: boolean; resume?: boolean; timeoutMs?: number; pollMs?: number }

/** Only raster image bytes are accepted, never HTML or SVG returned as a picture. */
export function imageExtension(bytes: Uint8Array): 'png' | 'jpg' | 'webp' {
  const data = Buffer.from(bytes);
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'jpg';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'webp';
  throw new Error('Expected PNG, JPEG or WebP image bytes.');
}

function safeUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Image download requires an HTTPS URL without embedded credentials.');
  return url;
}
async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('Response exceeds the allowed size.'); }
  if (!response.body) throw new Error('Response has no body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('Response exceeds the allowed size.');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}
async function api(route: string, key: string, timeout: number, payload?: object): Promise<Reply> {
  const response = await fetch(endpoint + route, {
    method: payload ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeout))),
    headers: { Authorization: `Bearer ${key}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`AA image API HTTP ${response.status}; the generation request is not automatically retried.`); }
  let reply: Reply;
  const body = await boundedBody(response, 1024 * 1024);
  try { reply = JSON.parse(body.toString('utf8')); }
  catch { throw new Error('AA image API returned invalid JSON; the response body is not logged.'); }
  if (reply.code !== 0 || !reply.data || typeof reply.data !== 'object') throw new Error('AA image API returned an unsuccessful or invalid response; inspect the provider console.');
  if (reply.data.urls !== undefined && (!Array.isArray(reply.data.urls) || reply.data.urls.some(url => typeof url !== 'string'))) throw new Error('AA image API returned invalid image URLs.');
  if (reply.data.task_id !== undefined && (typeof reply.data.task_id !== 'string' || !reply.data.task_id.trim())) throw new Error('AA image API returned an invalid task ID.');
  return reply;
}
async function downloadImage(value: string, deadline: number): Promise<Buffer> {
  let url = safeUrl(value);
  for (let redirect = 0; redirect <= 5; redirect++) {
    // Never forward the API Bearer credential to the image storage server.
    if (Date.now() >= deadline) throw new Error('Image download timed out. Resume the saved task instead of generating again.');
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(90000, deadline - Date.now())))) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Image redirect has no location.');
      url = safeUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Image download HTTP ${response.status}; resume this task instead of generating again.`); }
    const bytes = await boundedBody(response, imageLimit);
    imageExtension(bytes);
    return bytes;
  }
  throw new Error('Image download has too many redirects.');
}
function validateRequest(model: string, size: string, maxImages: number): void {
  if (!models.includes(model)) throw new Error('Choose a documented doubao-seedream 4.0, 4.5 or 5.0 model ID.');
  if (!Number.isInteger(maxImages) || maxImages < 1 || maxImages > 15) throw new Error('max-images must be an integer from 1 to 15.');
  const preset = model.includes('-4-0-') ? ['1K', '2K', '4K'] : model.includes('-5-0-') ? ['2K', '3K', '4K'] : ['2K', '4K'];
  if (preset.includes(size)) return;
  const match = /^(\d+)x(\d+)$/.exec(size);
  const width = Number(match?.[1]), height = Number(match?.[2]);
  const minimum = model.includes('-4-0-') ? 921600 : 3686400;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width * height < minimum || width * height > 16777216 || width / height < 1 / 16 || width / height > 16) throw new Error('Image size exceeds the documented model pixel or aspect-ratio limits.');
}

/** Submit once, poll the documented task endpoint, then save local images for rendering. */
export async function generateImages(options: ImageOptions): Promise<string[]> {
  const key = process.env.AA_API_KEY?.trim();
  if (!key || /[\r\n]/.test(key)) throw new Error('Set AA_API_KEY in the Node environment; never put it in the brief or browser.');
  const timeout = options.timeoutMs ?? 600000, poll = options.pollMs ?? 5000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600000 || !Number.isInteger(poll) || poll < 1 || poll > 60000) throw new Error('Invalid image request timeout or poll interval.');
  const target = path.resolve(options.output);
  const parent = realpathSync(path.dirname(target));
  const relative = path.relative(realpathSync(root), path.join(parent, path.basename(target)));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Image output must be inside the production workspace.');
  let task: Task;
  let payload: object | undefined;
  if (options.resume) {
    if (options.prompt !== undefined || options.references?.length) throw new Error('Resume only queries the saved task; do not supply a new prompt or reference.');
    const canonical = realpathSync(target);
    if (canonical !== path.join(parent, path.basename(target))) throw new Error('Image output must not be a symlink.');
    task = JSON.parse(readFileSync(path.join(target, 'task.json'), 'utf8'));
    if (realpathSync(path.join(target, 'task.json')) !== path.join(canonical, 'task.json')) throw new Error('Task record must not be a symlink.');
    validateRequest(task.model, task.size, task.maxImages);
    if (!task.taskId && !task.urls?.length) throw new Error('No saved task ID or image URLs. Check the provider console; do not blindly resubmit a possibly charged request.');
  } else {
    const model = options.model ?? models[0]!, size = options.size ?? '2848x1600', maxImages = options.maxImages ?? 1;
    validateRequest(model, size, maxImages);
    if (!options.prompt?.trim()) throw new Error('Provide a nonempty image prompt.');
    if ((options.references?.length ?? 0) > 14) throw new Error('At most 14 reference images are supported.');
    const references = options.references?.map(filename => {
      if (!statSync(filename).isFile() || statSync(filename).size > 30 * 1024 * 1024) throw new Error('A reference image must be a file of at most 30 MiB.');
      const bytes = readFileSync(filename), extension = imageExtension(bytes);
      const probe = spawnSync(mediaPath('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', filename], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      if (probe.error || probe.status !== 0) throw new Error('Reference image cannot be decoded; prepare FFmpeg with scripts/bootstrap.mjs.');
      const dimensions = JSON.parse(probe.stdout).streams?.[0];
      const width = dimensions?.width, height = dimensions?.height;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 14 || height <= 14 || width * height > 36000000 || width / height < 1 / 16 || width / height > 16) throw new Error('Reference image exceeds the documented pixel or aspect-ratio limits.');
      return `data:image/${extension === 'jpg' ? 'jpeg' : extension};base64,${bytes.toString('base64')}`;
    });
    payload = { model, prompt: options.prompt.trim(), size, response_format: 'url', stream: false, sequential_image_generation: maxImages === 1 ? 'disable' : 'auto', ...(maxImages > 1 ? { sequential_image_generation_options: { max_images: maxImages } } : {}), ...(references?.length ? { image: references.length === 1 ? references[0] : references } : {}), ...(options.watermark !== undefined ? { watermark: options.watermark } : {}) };
    mkdirSync(target); // Exclusive: a new request cannot overwrite an earlier generation.
    task = { model, size, maxImages, status: 'submission-uncertain' };
    writeFileSync(path.join(target, 'prompt.txt'), options.prompt.trim() + '\n', { flag: 'wx' });
  }
  const record = path.join(target, 'task.json');
  const save = () => {
    const pending = record + '.' + randomUUID() + '.tmp';
    writeFileSync(pending, JSON.stringify(task, null, 2).replaceAll(key, '[redacted]') + '\n', { flag: 'wx' });
    renameSync(pending, record);
  };
  save(); // Keep recovery information even if a paid POST times out.
  const deadline = Date.now() + timeout;
  const apply = (reply: Reply) => {
    task.taskId = reply.data.task_id ?? task.taskId;
    task.requestId = reply.request_id ?? task.requestId;
    task.status = reply.data.task_status ?? 'pending';
    task.usage = reply.data.usage;
    task.expired = reply.data.expired ?? task.expired;
    task.urls = reply.data.urls?.length ? reply.data.urls : task.urls;
    save();
    // The docs do not enumerate statuses: URLs determine readiness, failures stop polling.
    if (/fail|error|cancel|expir|reject/i.test(task.status)) throw new Error('Image generation task failed; inspect the provider console. No POST was retried.');
  };
  try {
    if (payload) {
      console.log('提交豆包生图请求；此操作可能计费，不自动重发。');
      apply(await api('/image/generation', key, timeout, payload));
    }
    else if (task.taskId) apply(await api(`/task/${encodeURIComponent(task.taskId)}`, key, Math.min(timeout, 90000)));
    while (!task.urls?.length) {
      if (!task.taskId) throw new Error('AA image API returned neither image URLs nor a task ID.');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Image task timed out. Resume this output directory to query the saved task; no new generation is needed.');
      await delay(Math.min(poll, remaining));
      if (Date.now() >= deadline) continue;
      apply(await api(`/task/${encodeURIComponent(task.taskId)}`, key, Math.min(90000, deadline - Date.now())));
    }
    if (task.urls.length > task.maxImages) throw new Error('AA image API returned more images than requested; the saved task was not resubmitted.');
    const files: string[] = [];
    for (const [index, url] of task.urls.entries()) {
      if (url.includes(key)) throw new Error('Image URL unexpectedly contains the API credential.');
      const existing = task.files?.[index];
      if (existing && /^image-\d+\.(?:png|jpg|webp)$/.test(existing) && existsSync(path.join(target, existing))) {
        if (path.dirname(realpathSync(path.join(target, existing))) !== realpathSync(target)) throw new Error('Saved image must not link outside the generation directory.');
        imageExtension(readFileSync(path.join(target, existing))); files.push(existing); continue;
      }
      const bytes = await downloadImage(url, deadline);
      const filename = `image-${index + 1}.${imageExtension(bytes)}`;
      writeFileSync(path.join(target, filename), bytes, { flag: 'wx' });
      files.push(filename);
      task.files = [...files]; save();
    }
    task.status = 'downloaded-awaiting-visual-review';
    save();
    return files.map(filename => path.join(target, filename));
  } catch (error) {
    // Raw provider responses may echo credentials: never print them or the Authorization header.
    throw new Error((error instanceof Error ? error.message : 'Image generation failed.').replaceAll(key, '[redacted]'));
  }
}

export async function imageCli(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, strict: true, options: {
    prompt: { type: 'string' }, output: { type: 'string' }, model: { type: 'string' }, size: { type: 'string' }, reference: { type: 'string', multiple: true }, 'max-images': { type: 'string' }, watermark: { type: 'boolean' }, resume: { type: 'boolean' }, 'timeout-seconds': { type: 'string' },
  } });
  if (!values.output || (!values.resume && !values.prompt)) throw new Error('Usage: node deepseek/lib/image.js --prompt inputs/image-prompt.txt --output inputs/generated/hero [--reference inputs/product.png] OR --resume --output inputs/generated/hero');
  const files = await generateImages({ output: values.output, ...(values.prompt ? { prompt: readFileSync(values.prompt, 'utf8') } : {}), ...(values.model ? { model: values.model } : {}), ...(values.size ? { size: values.size } : {}), ...(values.reference ? { references: values.reference } : {}), ...(values['max-images'] ? { maxImages: Number(values['max-images']) } : {}), ...(values.watermark !== undefined ? { watermark: values.watermark } : {}), ...(values.resume ? { resume: true } : {}), ...(values['timeout-seconds'] ? { timeoutMs: Number(values['timeout-seconds']) * 1000 } : {}) });
  console.log(`生成图片已保存，待视觉检查：\n${files.join('\n')}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  imageCli(process.argv.slice(2)).catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
}
