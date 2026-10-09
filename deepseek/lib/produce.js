import { spawnSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseSrt, simplified } from './srt.js';
import { selectTemplate } from './templates.js';
import { imageExtension } from './image.js';
import { startServer } from '../../serve.mjs';
import { launchBrowser } from '../../scripts/browser.mjs';
import { mediaPath } from '../../scripts/media-tools.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0)
        throw new Error(`${path.basename(command)} failed: ${result.error?.message ?? result.stderr?.slice(-4000)}`);
    return result.stdout;
}
function probe(video) {
    return JSON.parse(run(mediaPath('ffprobe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video]));
}
function inside(directory, file) {
    const relative = path.relative(directory, file);
    return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
function json(file, value) { writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
function validateEncoding(width, height, fps) {
    if (![width, height].every(value => Number.isInteger(value) && value >= 128 && value <= 4096 && value % 2 === 0) || !Number.isInteger(fps) || fps < 1 || fps > 60)
        throw new Error('Use even dimensions 128–4096 and an integer frame rate 1–60.');
}
function validateMusicVolume(volume) {
    if (!Number.isFinite(volume) || volume < 0 || volume > .3)
        throw new Error('Music volume must be between 0 and 0.3 to protect the speech track.');
}
/** Render an editable project at absolute times and mux its original speech audio. */
export async function renderProject(directory) {
    const target = realpathSync(directory);
    if (!inside(realpathSync(root), target))
        throw new Error('Render project must be inside the production workspace.');
    const film = JSON.parse(readFileSync(path.join(target, 'film.json'), 'utf8'));
    validateEncoding(film.width, film.height, film.fps);
    if (!Number.isFinite(film.duration) || film.duration <= 0)
        throw new Error('Invalid film duration.');
    if (film.music)
        validateMusicVolume(film.music.volume);
    if (film.backgroundImage !== undefined) {
        if (typeof film.backgroundImage !== 'string' || !/^background\.(?:png|jpg|webp)$/.test(film.backgroundImage) || !inside(target, realpathSync(path.join(target, film.backgroundImage))))
            throw new Error('Background image must be a local PNG, JPEG or WebP inside the film directory.');
        imageExtension(readFileSync(path.join(target, film.backgroundImage)));
    }
    const output = path.join(target, 'final.mp4');
    if (existsSync(output))
        throw new Error('final.mp4 already exists. Rename it before re-rendering; no finished output is overwritten.');
    const frames = path.join(target, 'frames');
    mkdirSync(frames, { recursive: true });
    const service = await startServer({ port: 0, root });
    let browser;
    try {
        browser = await launchBrowser();
        const page = await browser.newPage({ viewport: { width: film.width, height: film.height }, deviceScaleFactor: 1 });
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        page.on('console', message => { if (message.type() === 'error')
            pageErrors.push(message.text()); });
        const route = path.relative(root, target).split(path.sep).map(encodeURIComponent).join('/');
        await page.goto(`${service.url}/${route}/index.html?capture=1`);
        await page.waitForFunction(() => 'film' in window, null, { timeout: 30000 });
        const count = Math.ceil(film.duration * film.fps);
        for (let frame = 0; frame < count; frame++) {
            await page.evaluate(async (time) => {
                const view = window;
                await view.film.renderAt(time);
            }, frame / film.fps);
            await page.screenshot({ path: path.join(frames, `frame-${String(frame).padStart(6, '0')}.png`) });
            if (frame % film.fps === 0)
                console.log(`渲染 ${frame}/${count} 帧`);
        }
        if (pageErrors.length)
            throw new Error(pageErrors.join('\n'));
        const inputs = ['-framerate', String(film.fps), '-i', path.join(frames, 'frame-%06d.png'), '-i', path.join(target, 'source.mp4')];
        const map = ['-map', '0:v:0'];
        if (film.music) {
            inputs.push('-stream_loop', '-1', '-i', path.join(target, 'music.audio'));
            const bed = `[2:a]volume=${film.music.volume},aresample=async=1:first_pts=0[bed]`;
            map.push('-filter_complex', film.hasAudio ? `[1:a]aresample=async=1:first_pts=0,apad[speech];${bed};[speech][bed]amix=inputs=2:duration=longest:normalize=0[mix]` : `${bed};[bed]anull[mix]`, '-map', '[mix]', '-c:a', 'aac', '-b:a', '192k');
        }
        else
            map.push(...(film.hasAudio ? ['-map', '1:a:0', '-af', 'aresample=async=1:first_pts=0,apad', '-c:a', 'aac', '-b:a', '192k'] : ['-an']));
        const pending = path.join(target, 'final.pending.mp4');
        run(mediaPath('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', ...inputs, ...map, '-t', String(film.duration), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', pending]);
        const metadata = probe(pending);
        if (!metadata.streams.some(stream => stream.codec_name === 'h264') || (film.hasAudio && !metadata.streams.some(stream => stream.codec_type === 'audio')) || Math.abs(Number(metadata.format.duration) - film.duration) > 1 / film.fps + 0.05)
            throw new Error('Output codec, audio or duration validation failed.');
        copyFileSync(pending, output, constants.COPYFILE_EXCL);
        unlinkSync(pending);
        json(path.join(target, 'validation.json'), { video: metadata, fps: film.fps, frames: count, style: film.style.name, subtitleLanguage: 'zh-CN', originalSpeechAudio: film.hasAudio, status: 'rendered-awaiting-audiovisual-review', scope: '编码、字幕时序和音轨检查通过；人物边缘、完整连续动作及声音仍需实际复查。' });
        console.log(`输出：${output}\n预览与可编辑工程：${path.join(target, 'index.html')}`);
    }
    finally {
        await browser?.close();
        await new Promise(resolve => service.server.close(() => resolve()));
    }
}
/** Run SRT → CPU matting → template scene → original audio → H.264 pipeline. */
export async function produce(args) {
    const { values } = parseArgs({ args, options: {
            video: { type: 'string' }, srt: { type: 'string' }, brief: { type: 'string' }, output: { type: 'string' }, style: { type: 'string' },
            width: { type: 'string', default: '1920' }, height: { type: 'string', default: '1080' }, fps: { type: 'string', default: '30' },
            'keep-background': { type: 'boolean', default: false }, 'preview-only': { type: 'boolean', default: false },
            'person-x': { type: 'string' }, 'person-y': { type: 'string' }, 'person-scale': { type: 'string', default: '1' }, music: { type: 'string' }, 'music-volume': { type: 'string', default: '0.08' },
            'background-image': { type: 'string' },
        }, strict: true });
    if (!values.video || !values.srt || !values.brief || !values.output)
        throw new Error('Usage: npm run produce -- --video inputs/source.mp4 --srt inputs/source.srt --brief inputs/brief.txt --output work/my-film [--style 科技感|教育风|营销风]');
    const video = realpathSync(path.resolve(values.video));
    const srt = readFileSync(path.resolve(values.srt), 'utf8');
    const brief = readFileSync(path.resolve(values.brief), 'utf8');
    if (!brief.trim())
        throw new Error('Brief is empty.');
    const cues = parseSrt(srt);
    const style = selectTemplate(brief, values.style);
    const keyPoints = simplified(/要点\s*[:：]\s*([^\n]+)/.exec(brief)?.[1] ?? '').split(/[\/／|｜；;]/).map(value => value.trim()).filter(Boolean);
    if (keyPoints.length && keyPoints.length !== 3)
        throw new Error('Specify three key points using 要点：第一点／第二点／第三点.');
    if (keyPoints.some(value => value.length > 18 || !/\p{Script=Han}/u.test(value)))
        throw new Error('Each key point must contain Chinese and fit within 18 characters.');
    if (!keyPoints.length)
        for (const position of [0, Math.floor(cues.length / 2), cues.length - 1])
            keyPoints.push(cues[position].text.replace(/\n/g, '').slice(0, 18));
    const framing = { anchorX: values['person-x'] === undefined ? undefined : Number(values['person-x']), anchorY: values['person-y'] === undefined ? undefined : Number(values['person-y']), scale: Number(values['person-scale']) };
    if ([framing.anchorX, framing.anchorY].some(value => value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) || !Number.isFinite(framing.scale) || framing.scale < 1 || framing.scale > 3)
        throw new Error('Person anchors must be 0–1 and person scale must be 1–3.');
    const musicVolume = Number(values['music-volume']);
    validateMusicVolume(musicVolume);
    const music = values.music ? realpathSync(path.resolve(values.music)) : undefined;
    if (music && !probe(music).streams.some(stream => stream.codec_type === 'audio'))
        throw new Error('Background music must contain an audio stream.');
    const metadata = probe(video);
    const source = metadata.streams.find(stream => stream.codec_type === 'video');
    const duration = Number(metadata.format.duration);
    if (!source?.width || !source.height || !Number.isFinite(duration) || duration <= 0)
        throw new Error('Input must contain a readable video stream.');
    const width = Number(values.width), height = Number(values.height), fps = Number(values.fps);
    validateEncoding(width, height, fps);
    if (cues.at(-1).end > duration + 1 / fps)
        throw new Error('SRT ends after the source recording. Correct its timing before production.');
    const title = simplified(/标题\s*[:：]\s*([^\n]+)/.exec(brief)?.[1]?.trim() ?? style.content.title);
    if (!/\p{Script=Han}/u.test(title))
        throw new Error('Title must contain Chinese text.');
    if (title.replace(/\s/g, '').length > 36)
        throw new Error('Keep the visible title within 36 Chinese characters.');
    const background = values['background-image'] ? realpathSync(path.resolve(values['background-image'])) : undefined;
    const backgroundName = background ? `background.${imageExtension(readFileSync(background))}` : undefined;
    if (background && !probe(background).streams.some(stream => stream.codec_type === 'video' && stream.width && stream.height))
        throw new Error('Background image cannot be decoded.');
    const target = path.resolve(values.output);
    const parent = realpathSync(path.dirname(target));
    if (!inside(realpathSync(root), path.join(parent, path.basename(target))))
        throw new Error('Output must be a new directory inside this production workspace.');
    mkdirSync(target);
    copyFileSync(video, path.join(target, 'source.mp4'));
    writeFileSync(path.join(target, 'source.srt'), srt);
    writeFileSync(path.join(target, 'brief.txt'), brief);
    console.log(`模板：${style.name}；字幕：${cues.length} 条；原片：${duration.toFixed(2)} 秒`);
    const matte = spawnSync(process.execPath, [path.join(root, 'scripts/matte.mjs'), '--input', video, '--output', path.join(target, 'person'), '--fps', String(fps), '--max-size', String(Math.max(width, height))], { cwd: root, stdio: 'inherit', windowsHide: true });
    if (matte.error || matte.status !== 0)
        throw new Error('CPU matting failed. Run npm run onboard; inspect the error and keep the existing partial project.');
    if (music)
        copyFileSync(music, path.join(target, 'music.audio'));
    if (background && backgroundName)
        copyFileSync(background, path.join(target, backgroundName));
    const film = { width, height, fps, duration, title, style, cues, keepBackground: values['keep-background'], hasAudio: metadata.streams.some(stream => stream.codec_type === 'audio'), sourceWidth: source.width, sourceHeight: source.height, keyPoints, framing, ...(music ? { music: { volume: musicVolume } } : {}), ...(backgroundName ? { backgroundImage: backgroundName } : {}) };
    json(path.join(target, 'film.json'), film);
    copyFileSync(path.join(root, 'deepseek/scene.mjs'), path.join(target, 'scene.mjs'));
    const importPath = path.relative(target, path.join(root, 'node_modules/three/build/three.module.js')).split(path.sep).map(segment => encodeURIComponent(segment)).join('/');
    const fonts = [];
    for (const [family, asset] of [[style.typography.titleFont, style.typography.titleFontPath], [style.typography.bodyFont, style.typography.bodyFontPath]]) {
        const filename = realpathSync(path.join(root, asset));
        if (!inside(realpathSync(path.join(root, 'reference-library/typography')), filename))
            throw new Error('Template font must be inside the licensed typography library.');
        const url = path.relative(target, filename).split(path.sep).map(encodeURIComponent).join('/');
        fonts.push(`@font-face{font-family:${JSON.stringify(family)};src:url(${JSON.stringify(url)}) format('truetype');font-weight:100 900}`);
    }
    writeFileSync(path.join(target, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>影片预览</title><style>${fonts.join('\n')}html,body{margin:0;background:${style.palette.background};overflow:hidden}canvas{display:block;width:100vw;height:100vh}</style><script type="importmap">${JSON.stringify({ imports: { three: importPath } })}</script><script type="module">import {mount} from './scene.mjs';await mount();</script></html>`);
    const renderModule = path.relative(target, path.join(root, 'deepseek/lib/produce.js')).split(path.sep).join('/');
    writeFileSync(path.join(target, 'render.mjs'), `import {renderProject} from ${JSON.stringify(renderModule.startsWith('.') ? renderModule : './' + renderModule)};import{fileURLToPath}from'node:url';await renderProject(fileURLToPath(new URL('.',import.meta.url)));\n`);
    writeFileSync(path.join(target, 'README.md'), `# 可编辑影片\n\n风格：${style.name}。编辑 scene.mjs、film.json 后，从制作工程根运行 node ${path.relative(root, path.join(target, 'render.mjs')).split(path.sep).join('/')} 重渲染；已有 final.mp4 须先重命名。\n\n运行 npm run serve 打开本目录的 index.html。归档/交付时保留完整制作工程根目录，包括依赖、字体、原素材、人物层与本目录。\n\n输出编码与音轨检查不代替实际人物边缘、连续动作和完整试听。\n`);
    if (!values['preview-only'])
        await renderProject(target);
    return target;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    produce(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
