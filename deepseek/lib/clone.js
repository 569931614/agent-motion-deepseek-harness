import { createReadStream } from 'node:fs';
import { access, link, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { uploadPrivateMedia } from './avatar.js';
const endpoint = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization';
const targetModel = 'cosyvoice-v3.5-plus';
const jsonLimit = 1024 * 1024;
export class CloneError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'CloneError';
    }
}
function within(directory, filename) {
    const relative = path.relative(directory, filename);
    return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function processEnvironment() {
    const env = { ...process.env, PYTHONUTF8: '1', PYTHONNOUSERSITE: '1' };
    // Media decoding and environment installation have no need for service credentials.
    for (const name of Object.keys(env))
        if (/DASHSCOPE|YIDEVS|MOTION_OSS_|AA_API_KEY|API_?KEY|ACCESS_?KEY|SECRET|TOKEN|CREDENTIAL|PASSWORD/i.test(name))
            delete env[name];
    return env;
}
async function runProcess(command, args, options) {
    options.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        let settled = false, length = 0;
        const chunks = [];
        const child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
        const stop = () => {
            if (!child.pid)
                return;
            if (process.platform === 'win32') {
                const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
                killer.on('error', () => { child.kill('SIGKILL'); });
                killer.unref();
            }
            else {
                try {
                    process.kill(-child.pid, 'SIGKILL');
                }
                catch {
                    child.kill('SIGKILL');
                }
            }
        };
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            options.signal.removeEventListener('abort', abort);
            if (error) {
                stop();
                reject(error);
            }
            else
                resolve(Buffer.concat(chunks).toString('utf8'));
        };
        const abort = () => finish(new CloneError('CLONE_CANCELLED', '音色创建已停止。'));
        const timer = setTimeout(() => finish(new CloneError('CLONE_TIMEOUT', '音色准备过程超时，请保留任务目录。')), options.timeoutMs);
        options.signal.addEventListener('abort', abort, { once: true });
        const collect = (chunk) => {
            if (settled)
                return;
            length += chunk.length;
            if (length > options.maxOutputBytes) {
                finish(new CloneError('CLONE_MEDIA', '媒体工具输出超出限制。'));
                return;
            }
            chunks.push(chunk);
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.on('error', () => finish(new CloneError('CLONE_MEDIA', '媒体工具无法启动。')));
        child.on('close', code => finish(code === 0 ? undefined : new CloneError('CLONE_MEDIA', '媒体工具执行失败。')));
        if (options.signal.aborted)
            abort();
    });
}
async function save(filename, record) {
    const pending = `${filename}.${randomUUID()}.tmp`;
    let handle;
    try {
        handle = await open(pending, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(record, null, 2) + '\n');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(pending, filename);
    }
    finally {
        await handle?.close().catch(() => { });
        await unlink(pending).catch(() => { });
    }
}
async function load(filename) {
    let info;
    try {
        info = await stat(filename);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
    if (!info.isFile() || info.size > jsonLimit || await realpath(filename) !== filename)
        throw new CloneError('CLONE_RECORD', '音色任务记录无效，请保留目录并检查已有任务。');
    let record;
    try {
        record = JSON.parse(await readFile(filename, 'utf8'));
    }
    catch {
        throw new CloneError('CLONE_RECORD', '音色任务记录无法读取，请勿重复提交。');
    }
    if (record?.version !== 1 || !/^[a-f0-9-]{36}$/.test(record.requestId) || !['prepared', 'submission-uncertain', 'processing', 'ready', 'rejected'].includes(record.status)
        || typeof record.videoPath !== 'string' || record.targetModel !== targetModel || typeof record.sampleFilename !== 'string'
        || path.basename(record.sampleFilename) !== record.sampleFilename || !/^clone-sample-[a-f0-9-]{36}\.wav$/.test(record.sampleFilename)
        || (record.voiceId !== undefined && !validVoiceId(record.voiceId, [])))
        throw new CloneError('CLONE_RECORD', '音色任务记录无效，请勿重复提交。');
    return record;
}
function validVoiceId(value, secrets) {
    return typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,256}$/.test(value) && !secrets.some(secret => value.includes(secret));
}
async function lock(directory) {
    const filename = path.join(directory, 'clone-request.lock'), owner = randomUUID();
    let handle;
    try {
        handle = await open(filename, 'wx', 0o600);
    }
    catch (error) {
        if (error.code === 'EEXIST')
            throw new CloneError('CLONE_BUSY', '音色任务已有处理者或遗留锁。确认原处理进程已停止后，保留任务记录再手动移除锁。');
        throw error;
    }
    try {
        await handle.writeFile(JSON.stringify({ owner, pid: process.pid }));
    }
    finally {
        await handle.close();
    }
    return async () => {
        try {
            if (JSON.parse(await readFile(filename, 'utf8')).owner === owner)
                await unlink(filename);
        }
        catch { /* Preserve a lock changed by another owner. */ }
    };
}
async function boundedJson(response, signal) {
    if (Number(response.headers.get('content-length')) > jsonLimit) {
        await response.body?.cancel();
        throw new CloneError('CLONE_RESPONSE', '音色服务响应超出限制。');
    }
    if (!response.body)
        throw new CloneError('CLONE_RESPONSE', '音色服务返回空响应。');
    const reader = response.body.getReader(), chunks = [];
    let bytes = 0;
    const abort = () => { void reader.cancel().catch(() => { }); };
    signal.addEventListener('abort', abort, { once: true });
    try {
        for (;;) {
            signal.throwIfAborted();
            const part = await reader.read();
            signal.throwIfAborted();
            if (part.done)
                break;
            bytes += part.value.length;
            if (bytes > jsonLimit)
                throw new CloneError('CLONE_RESPONSE', '音色服务响应超出限制。');
            chunks.push(part.value);
        }
        try {
            return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
        }
        catch {
            throw new CloneError('CLONE_RESPONSE', '音色服务返回无效 JSON，响应内容未保存。');
        }
    }
    catch (error) {
        await reader.cancel().catch(() => { });
        throw error;
    }
    finally {
        signal.removeEventListener('abort', abort);
        reader.releaseLock();
    }
}
/** Extract the speaker sample once, create one voice, then resume by querying its ID. */
export async function cloneVideoVoice(options) {
    const internal = options.internal ?? {}, network = internal.fetch ?? fetch, run = internal.run ?? runProcess;
    const now = internal.now ?? Date.now, wait = internal.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
    const timeout = internal.timeoutMs ?? 3600000, requestTimeout = internal.requestTimeoutMs ?? 90000, poll = internal.pollMs ?? 5000;
    if (![timeout, requestTimeout, poll].every(value => Number.isInteger(value) && value > 0) || timeout > 3600000 || requestTimeout > 90000 || poll > 5000)
        throw new CloneError('CLONE_INPUT', '音色请求超时参数无效。');
    const credentials = options.credentials ?? process.env, key = credentials.DASHSCOPE_API_KEY?.trim();
    if (!key || /[\r\n]/.test(key))
        throw new CloneError('CLONE_CONFIG', options.credentials !== undefined ? '请在 Harness 插件设置中填写北京地域 DASHSCOPE_API_KEY。' : '请在服务端设置北京地域 DASHSCOPE_API_KEY。');
    const directory = await realpath(path.resolve(options.directory)), workspace = await realpath(path.resolve(options.workspace));
    if (!(await stat(directory)).isDirectory() || !(await stat(workspace)).isDirectory())
        throw new CloneError('CLONE_INPUT', '音色任务与工程目录无效。');
    const outer = options.signal ?? new AbortController().signal;
    const signal = AbortSignal.any([outer, AbortSignal.timeout(timeout)]), deadline = now() + timeout;
    const check = () => {
        if (outer.aborted)
            throw new CloneError('CLONE_CANCELLED', '音色创建已停止；已有音色编号可续查，不会重复创建。');
        if (signal.aborted || now() >= deadline)
            throw new CloneError('CLONE_TIMEOUT', '音色创建超时，请保留任务目录并续查。');
    };
    const scoped = (ms) => { check(); return AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(ms, deadline - now())))]); };
    const stage = async (value) => {
        check();
        const pending = Promise.resolve().then(() => options.onStage?.(value));
        let abort = () => { };
        try {
            await Promise.race([pending, new Promise((_resolve, reject) => {
                    abort = () => reject(new CloneError(outer.aborted ? 'CLONE_CANCELLED' : 'CLONE_TIMEOUT', '音色创建已停止或超时，请保留任务目录。'));
                    signal.addEventListener('abort', abort, { once: true });
                    if (signal.aborted)
                        abort();
                })]);
        }
        finally {
            signal.removeEventListener('abort', abort);
        }
        check();
    };
    const processRun = async (command, args, milliseconds) => {
        check();
        const active = scoped(milliseconds);
        const result = await run(command, args, { cwd: workspace, env: processEnvironment(), signal: active, timeoutMs: Math.max(1, Math.min(milliseconds, deadline - now())), maxOutputBytes: jsonLimit });
        active.throwIfAborted();
        check();
        if (Buffer.byteLength(result) > jsonLimit)
            throw new CloneError('CLONE_MEDIA', '媒体工具输出超出限制。');
        return result;
    };
    const api = async (input) => {
        const active = scoped(requestTimeout);
        const response = await network(endpoint, { method: 'POST', redirect: 'error', signal: active,
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'voice-enrollment', input }) });
        active.throwIfAborted();
        if (!response.ok) {
            await response.body?.cancel();
            throw new CloneError('CLONE_HTTP', `音色服务请求失败（HTTP ${response.status}），不会自动重复创建。`);
        }
        const reply = await boundedJson(response, active);
        check();
        if (!reply || typeof reply !== 'object' || !reply.output || typeof reply.output !== 'object' || Array.isArray(reply.output) || (reply.code !== undefined && reply.code !== 200 && reply.code !== 0 && reply.code !== '200'))
            throw new CloneError('CLONE_RESPONSE', '音色服务返回失败或无效响应，响应内容未保存。');
        return reply.output;
    };
    check();
    const release = await lock(directory);
    try {
        const filename = path.join(directory, 'clone-request.json');
        let record = await load(filename);
        const requestedVideo = path.resolve(options.videoPath);
        if (record && record.videoPath !== requestedVideo)
            throw new CloneError('CLONE_INPUT', '本目录已有不同的视频音色任务，请保留并续查原任务。');
        if (record && !record.voiceId && record.status !== 'prepared')
            throw new CloneError('CLONE_UNCERTAIN', '上次创建结果不确定且未保存音色编号，请先检查百炼控制台；不会自动重新创建。');
        const secrets = [key, credentials.YIDEVS_API_KEY, credentials.AA_API_KEY, credentials.MOTION_OSS_ACCESS_KEY_ID, credentials.MOTION_OSS_ACCESS_KEY_SECRET, credentials.MOTION_OSS_SECURITY_TOKEN].filter((value) => !!value);
        if (record?.voiceId && !validVoiceId(record.voiceId, secrets))
            throw new CloneError('CLONE_RECORD', '音色编号无效，请保留当前任务目录。');
        if (!record?.voiceId) {
            const video = await realpath(requestedVideo), info = await stat(video);
            if (!info.isFile() || !info.size || info.size > 1024 ** 3)
                throw new CloneError('CLONE_INPUT', '人物视频应为非空文件且不超过 1 GiB。');
            const hash = createHash('sha256');
            for await (const chunk of createReadStream(video, { signal })) {
                check();
                hash.update(chunk);
            }
            const sourceSha256 = hash.digest('hex');
            if (record?.sourceSha256 && record.sourceSha256 !== sourceSha256)
                throw new CloneError('CLONE_INPUT', '人物视频已变化，请使用新任务目录。');
            const candidates = (tool) => [
                path.join(workspace, '.runtime', 'media', ...(process.platform === 'win32' ? ['Library', 'bin', `${tool}.exe`] : ['bin', tool])),
                process.env[tool === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'], tool,
            ].filter((value) => !!value);
            const find = async (tool) => {
                for (const candidate of [...new Set(candidates(tool))]) {
                    try {
                        await processRun(candidate, ['-version'], 15000);
                        return candidate;
                    }
                    catch {
                        check();
                    }
                }
                return undefined;
            };
            let ffmpeg = await find('ffmpeg'), ffprobe = await find('ffprobe');
            if (!ffmpeg || !ffprobe) {
                await stage('准备运行环境');
                try {
                    await processRun(process.execPath, ['scripts/bootstrap.mjs'], 30 * 60 * 1000);
                }
                catch {
                    check();
                    throw new CloneError('CLONE_ENVIRONMENT', '环境准备失败，请检查工程安装入口后重试。');
                }
                ffmpeg = await find('ffmpeg');
                ffprobe = await find('ffprobe');
                if (!ffmpeg || !ffprobe)
                    throw new CloneError('CLONE_ENVIRONMENT', '环境准备失败，请检查 FFmpeg 和 FFprobe 安装后重试。');
            }
            const probe = async (file) => {
                let data;
                try {
                    data = JSON.parse(await processRun(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,sample_rate,channels,bits_per_sample,duration:format=duration,size', '-of', 'json', file], 30000));
                }
                catch {
                    check();
                    throw new CloneError('CLONE_MEDIA', '无法读取视频或样本音频，请检查原文件。');
                }
                return data;
            };
            const media = await probe(video), duration = Number(media?.format?.duration);
            const audio = media?.streams?.find((stream) => stream.codec_type === 'audio');
            if (!audio)
                throw new CloneError('CLONE_INPUT', '人物视频没有音轨，无法创建音色。');
            const audioDuration = Number(audio.duration);
            if (!Number.isFinite(duration) || duration < 5 || (Number.isFinite(audioDuration) && audioDuration < 5))
                throw new CloneError('CLONE_INPUT', '人物视频的语音音轨至少需要 5 秒。建议提供 10–20 秒单人清晰语音。');
            const requestId = record?.requestId ?? randomUUID();
            record = { version: 1, requestId, status: 'prepared', videoPath: requestedVideo, targetModel, sampleFilename: `clone-sample-${requestId}.wav`, sourceSha256 };
            await save(filename, record);
            const sample = path.join(directory, record.sampleFilename);
            if (!within(directory, sample))
                throw new CloneError('CLONE_INPUT', '音色样本必须位于当前任务目录。');
            if (!(await access(sample).then(() => true, () => false))) {
                const pending = path.join(directory, `.clone-sample-${randomUUID()}.wav`);
                try {
                    await stage('正在提取人物声音样本');
                    await processRun(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', video, '-map', '0:a:0', '-t', '20', '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', '-f', 'wav', '-n', pending], 90000);
                    check();
                    await link(pending, sample);
                }
                finally {
                    await unlink(pending).catch(() => { });
                }
            }
            if (await realpath(sample) !== sample)
                throw new CloneError('CLONE_INPUT', '音色样本不能是目录外的链接。');
            const sampleInfo = await stat(sample), metadata = await probe(sample), sampleDuration = Number(metadata?.format?.duration);
            const stream = metadata?.streams?.find((value) => value.codec_type === 'audio');
            if (!sampleInfo.isFile() || sampleInfo.size <= 0 || sampleInfo.size > 10000000 || !Number.isFinite(sampleDuration) || sampleDuration < 5 || sampleDuration > 20.1
                || stream?.codec_name !== 'pcm_s16le' || Number(stream?.sample_rate) !== 24000 || Number(stream?.channels) !== 1 || Number(stream?.bits_per_sample) !== 16)
                throw new CloneError('CLONE_INPUT', '声音样本须为 5–20 秒、单声道 24kHz 16-bit WAV，且不超过 10 MB。');
            await stage('正在上传声音样本');
            const url = await (internal.upload ?? uploadPrivateMedia)({ filePath: sample, objectKey: `agent-motion/voice-clone/${requestId}/sample.wav`, contentType: 'audio/wav', signal: scoped(requestTimeout), credentials: options.credentials });
            let uploadUrl;
            try {
                uploadUrl = new URL(url);
            }
            catch {
                throw new CloneError('CLONE_UPLOAD', '声音样本上传结果无效。');
            }
            if (uploadUrl.protocol !== 'https:' || uploadUrl.username || uploadUrl.password)
                throw new CloneError('CLONE_UPLOAD', '声音样本必须使用可访问的 HTTPS 地址。');
            check();
            record.status = 'submission-uncertain';
            await save(filename, record);
            await stage('正在创建人物音色');
            const output = await api({ action: 'create_voice', target_model: targetModel, prefix: `am${requestId.replaceAll('-', '').slice(0, 8)}`, url, language_hints: ['zh'] });
            if (!validVoiceId(output.voice_id, secrets))
                throw new CloneError('CLONE_UNCERTAIN', '音色服务没有返回有效音色编号，请检查百炼控制台；不会自动重新创建。');
            record.voiceId = output.voice_id;
            record.status = 'processing';
            await save(filename, record);
        }
        for (;;) {
            await stage('正在确认人物音色状态');
            const output = await api({ action: 'query_voice', voice_id: record.voiceId });
            // query_voice's documented reply omits voice_id; reject a mismatched ID if supplied.
            if (output.voice_id !== undefined && output.voice_id !== record.voiceId)
                throw new CloneError('CLONE_RESPONSE', '音色服务返回的音色编号不一致，请保留当前任务并续查。');
            if (output.target_model !== targetModel) {
                record.status = 'rejected';
                await save(filename, record);
                throw new CloneError('CLONE_MODEL', '音色绑定的模型与 cosyvoice-v3.5-plus 不一致，无法使用。');
            }
            if (output.status === 'OK') {
                record.status = 'ready';
                await save(filename, record);
                check();
                return { voiceId: record.voiceId };
            }
            if (output.status === 'UNDEPLOYED') {
                record.status = 'rejected';
                await save(filename, record);
                throw new CloneError('CLONE_REJECTED', '音色审核未通过，请检查原视频中的讲话是否清晰有效。');
            }
            if (output.status !== 'DEPLOYING')
                throw new CloneError('CLONE_RESPONSE', '音色服务返回未知状态，请保留音色编号并续查。');
            await wait(Math.min(poll, Math.max(1, deadline - now())), signal);
            check();
        }
    }
    catch (error) {
        if (outer.aborted)
            throw new CloneError('CLONE_CANCELLED', '音色创建已停止；已有音色编号可续查，不会重复创建。');
        if (signal.aborted || now() >= deadline || error?.name === 'TimeoutError')
            throw new CloneError('CLONE_TIMEOUT', '音色创建超时，请保留任务目录并续查。');
        if (error instanceof CloneError)
            throw error;
        throw new CloneError('CLONE_FAILED', '音色处理或环境准备失败，请保留任务目录检查已有音色；不会自动重复创建。');
    }
    finally {
        await release();
    }
}
