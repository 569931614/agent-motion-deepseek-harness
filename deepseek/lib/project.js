import { spawn } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPython } from '../../scripts/runtime.mjs';
const plugin = fileURLToPath(new URL('../../', import.meta.url));
const pending = new Map();
const cache = new Map();
const authoredFile = /\.(?:html?|mjs|cjs|js|css|json|txt|md|srt|vtt|glsl|vert|frag|mp4|webm|mov|wav|mp3|m4a|ogg|flac|audio|png|jpe?g|webp|gif|svg|ttf|otf|woff2?|glb|gltf|bin|obj|mtl)$/i;
const textFile = /\.(?:html?|mjs|cjs|js|css|json|txt|md|srt|vtt|svg|gltf)$/i;
const privateName = /^(?:credentials.*|agent-motion-cloud.*|id_rsa|id_ed25519)$|(?:^|[-_.])(?:secrets?|credentials?|api[-_]?keys?|requests?|responses?|replies|raw[-_]?api)(?:[-_.]|$)/i;
const excludedDirectory = /^(?:frames(?:[-_].*)?|cache(?:[-_].*)?|__pycache__|runtime|venv|node_modules)$/i;
const secretText = /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|\b(?:sk-proj-|sk-ws-|ghp_|github_pat_)[A-Za-z0-9_.-]{20,}|["'](?:[a-z0-9_.-]*(?:api[_-]?key|access[_-]?token|access[_-]?key(?:[_-]?(?:id|secret))?|secret[_-]?(?:id|key))|password|authorization|credentials?)["']\s*:\s*(?:["'][^"']+|\{)|[?&](?:q-signature|x-amz-signature|x-cos-security-token)=/i;
function within(root, file) {
    const relative = path.relative(root, file);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
/** Export only this task and its local preview/render dependencies; never the shared production root. */
export async function exportProject(workspace, taskId) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(taskId))
        throw new Error('Invalid project task ID.');
    const root = await realpath(workspace), key = path.join(root, 'work', taskId);
    if (pending.has(key))
        return pending.get(key);
    const operation = build(root, taskId);
    pending.set(key, operation);
    try {
        return await operation;
    }
    finally {
        pending.delete(key);
    }
}
async function build(root, taskId) {
    const taskPath = path.join(root, 'work', taskId), task = await realpath(taskPath);
    if (!within(taskPath, task))
        throw new Error('Project directory leaves the task boundary.');
    const entries = new Map();
    async function add(base, relative, destination = relative, options = {}) {
        if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(segment => segment === '..'))
            throw new Error('Unsafe project dependency path.');
        const name = path.basename(relative);
        if ((name.startsWith('.') && !(options.rules && name === '.agents')) || privateName.test(name) || excludedDirectory.test(name) || /\.py[co]$/i.test(name))
            return;
        const file = path.resolve(base, relative);
        let info;
        try {
            info = await lstat(file);
        }
        catch (error) {
            if (options.optional && error.code === 'ENOENT')
                return;
            throw error;
        }
        const canonical = await realpath(file);
        if (!within(base, canonical))
            throw new Error('Project dependency leaves its allowed directory.');
        if (info.isSymbolicLink())
            throw new Error('Linked project dependencies are not exportable.');
        if (info.isDirectory()) {
            for (const name of (await readdir(file)).sort())
                await add(base, path.join(relative, name), path.join(destination, name), options);
        }
        else if (info.isFile()) {
            if (options.authored && (!authoredFile.test(name) || /(?:\.before-|\.pending\.)/.test(name)))
                return;
            if (options.authored && textFile.test(name) && secretText.test(await readFile(canonical, 'utf8')))
                return;
            entries.set(destination.split(path.sep).join('/'), canonical);
        }
        else
            throw new Error('Project dependencies must be regular files.');
    }
    for (const filename of await readdir(task))
        await add(task, filename, `work/${taskId}/${filename}`, { authored: true });
    for (const filename of ['index.html', 'render.mjs', 'final.mp4'])
        if (!entries.has(`work/${taskId}/${filename}`))
            throw new Error(`Required project file is missing or private: ${filename}`);
    const hasSource = [...entries.keys()].some(name => name.startsWith(`work/${taskId}/`) && /\.(?:mjs|js)$/i.test(name) && name !== `work/${taskId}/render.mjs`);
    const html = await readFile(entries.get(`work/${taskId}/index.html`), 'utf8');
    const hasInlineModule = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].some(([, attributes, code]) => /(?:^|\s)type\s*=\s*(?:"module"|'module'|module(?=\s|$))/i.test(attributes) && !/(?:^|\s)src\s*=/i.test(attributes) && !!code.trim());
    if (!hasSource && !hasInlineModule)
        throw new Error('Editable project source is missing. Include JavaScript modules or an inline module in index.html.');
    await add(root, 'reference-library/typography/fonts');
    const inputsPath = path.join(root, 'inputs', 'studio', taskId);
    const inputs = await realpath(inputsPath).catch(error => { if (error.code === 'ENOENT')
        return undefined; throw error; });
    if (inputs && !within(inputsPath, inputs))
        throw new Error('Project inputs leave the task boundary.');
    if (inputs)
        for (const filename of await readdir(inputs))
            if (filename !== 'rules')
                await add(inputs, filename, `inputs/studio/${taskId}/${filename}`, { authored: true });
    const rules = path.join(inputsPath, 'rules');
    if (await stat(rules).then(() => true, error => { if (error.code === 'ENOENT')
        return false; throw error; })) {
        await add(rules, '.agents', '.agents', { rules: true });
        await add(rules, 'AGENTS.md', 'AGENTS.md');
        await add(inputsPath, 'rules', `inputs/studio/${taskId}/rules`, { rules: true });
    }
    else {
        await add(root, '.agents', '.agents', { rules: true, optional: true });
        await add(root, 'AGENTS.md', 'AGENTS.md', { optional: true });
    }
    for (const filename of ['serve.mjs', 'scripts', 'deepseek/lib/srt.js', 'LICENSE', 'NOTICE', 'COMMERCIAL-LICENSE.md', 'THIRD_PARTY_NOTICES.md'])
        await add(root, filename);
    await add(plugin, 'scripts/render-project.mjs');
    const dependencies = {};
    for (const dependency of ['three', 'playwright-core', 'opencc-js']) {
        const directory = path.join(root, 'node_modules', dependency);
        for (const filename of await readdir(directory))
            await add(directory, filename, `node_modules/${dependency}/${filename}`);
        dependencies[dependency] = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')).version;
    }
    await add(root, 'package-lock.json', 'package-lock.json', { optional: true });
    const signature = createHash('sha256');
    for (const [name, source] of entries) {
        const info = await stat(source);
        signature.update(JSON.stringify([name, info.size, info.mtimeMs]));
    }
    const digest = signature.digest('hex'), output = path.join(task, 'project.zip'), previous = cache.get(task);
    if (previous?.signature === digest && await realpath(output).then(file => within(task, file), () => false))
        return output;
    const temporary = await mkdtemp(path.join(task, '.project-export-'));
    try {
        const stage = path.join(temporary, 'project');
        for (const [name, source] of entries) {
            const destination = path.join(stage, name);
            await mkdir(path.dirname(destination), { recursive: true });
            await copyFile(source, destination);
        }
        await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'agent-motion-editable-film', private: true, type: 'module', dependencies, engines: { node: '>=22' }, scripts: { serve: 'node serve.mjs', render: `node work/${taskId}/render.mjs`, setup: 'node scripts/setup.mjs --core-only', onboard: 'node scripts/bootstrap.mjs', doctor: 'node scripts/doctor.mjs', matte: 'node scripts/matte.mjs', 'read-stage': 'node scripts/read-stage.mjs' } }, null, 2) + '\n');
        await writeFile(path.join(stage, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=work/${taskId}/index.html"><a href="work/${taskId}/index.html">打开影片预览</a></html>`);
        // Older template entry points import this path; keep their authored render.mjs unchanged.
        await writeFile(path.join(stage, 'deepseek', 'lib', 'produce.js'), `export {renderProject} from '../../scripts/render-project.mjs';\n`);
        await writeFile(path.join(stage, 'README.md'), `# 可编辑 Three.js 影片\n\n解压整个 ZIP，使用 Node.js 22/24 在根目录运行 \`npm run serve\`，打开终端给出的本地地址。HTML、字体、Three.js 和人物素材均在包内，预览无需云 API 或联网；浏览器的 file:// 模式无法加载 ES 模块和素材，请使用本地服务。\n\nwork/${taskId}/ 保留本片实际源码、数据、素材和作者原有的 render.mjs，不限定场景文件名或 film.json。编辑其中的工程文件后，按本片说明重命名已有成片，再运行 \`npm run render\` 执行作者的渲染入口；旧模板工程仍可使用 scene.mjs、film.json 及原渲染方式。人物抠图结果与输入素材保留原结构，配音与数字人口播素材在 inputs/studio/${taskId}/。\n\n重新渲染需要 FFmpeg、FFprobe 和 Chromium：默认读取系统 PATH 与 Playwright 已安装的浏览器。可通过 FFMPEG_PATH、FFPROBE_PATH、BROWSER_EXECUTABLE 指定程序路径，或 BROWSER_CHANNEL=msedge/chrome 使用本机浏览器；运行 \`npm run setup\` 自动准备 FFmpeg 与 Chromium。包不含操作系统专属运行环境或任何云凭据。\n\n如存在 inputs/studio/${taskId}/rules，那里是本片实际使用的 Skill 规则快照；可通过 \`node scripts/read-stage.mjs --rules-root inputs/studio/${taskId}/rules --stage composition --kind talking-head\` 读取，规则阅读需要 Python 3.10+。原项目和字体许可随包保留；发布前仍需实际观看与试听。\n`);
        const managed = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
        const python = await stat(managed).then(() => ({ command: managed, prefix: [] }), () => findPython());
        const archive = path.join(temporary, 'project.zip');
        await new Promise((resolve, reject) => {
            const child = spawn(python.command, [...python.prefix, '-c', 'import pathlib,sys,zipfile\nr=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2], "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:\n for p in sorted(r.rglob("*")):\n  if p.is_file(): z.write(p,p.relative_to(r).as_posix())', stage, archive], { windowsHide: true, stdio: 'ignore' });
            child.once('error', reject);
            child.once('close', code => code === 0 ? resolve() : reject(new Error('Project ZIP creation failed.')));
        });
        await rename(archive, output);
        cache.set(task, { signature: digest, output });
        return output;
    }
    finally {
        await rm(temporary, { recursive: true, force: true });
    }
}
