import { spawn } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPython } from '../../scripts/runtime.mjs';

const plugin = fileURLToPath(new URL('../../', import.meta.url));
const pending = new Map<string, Promise<string>>();
const cache = new Map<string, { signature: string; output: string }>();
const media = /\.(?:mp4|webm|wav|mp3|m4a|ogg|audio|png|jpe?g|webp|gif|svg|ttf|otf|woff2?)$/i;
const privateName = /^(?:\.env(?:\..*)?|credentials.*|agent-motion-cloud.*|id_rsa|id_ed25519)$/i;
function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Export only this task and its local preview/render dependencies; never the shared production root. */
export async function exportProject(workspace: string, taskId: string): Promise<string> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(taskId)) throw new Error('Invalid project task ID.');
  const root = await realpath(workspace), key = path.join(root, 'work', taskId);
  if (pending.has(key)) return pending.get(key)!;
  const operation = build(root, taskId);
  pending.set(key, operation);
  try { return await operation; }
  finally { pending.delete(key); }
}

async function build(root: string, taskId: string): Promise<string> {
  const taskPath = path.join(root, 'work', taskId), task = await realpath(taskPath);
  if (!within(taskPath, task)) throw new Error('Project directory leaves the task boundary.');
  const entries = new Map<string, string>();
  async function add(base: string, relative: string, destination = relative, optional = false): Promise<void> {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(segment => segment === '..' || privateName.test(segment))) throw new Error('Unsafe project dependency path.');
    const file = path.resolve(base, relative);
    let info;
    try { info = await lstat(file); }
    catch (error) { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const canonical = await realpath(file);
    if (!within(base, canonical)) throw new Error('Project dependency leaves its allowed directory.');
    if (info.isSymbolicLink()) throw new Error('Linked project dependencies are not exportable.');
    if (info.isDirectory()) {
      for (const name of (await readdir(file)).sort()) await add(base, path.join(relative, name), path.join(destination, name));
    } else if (info.isFile()) entries.set(destination.split(path.sep).join('/'), canonical);
    else throw new Error('Project dependencies must be regular files.');
  }
  for (const filename of ['index.html', 'scene.mjs', 'scene.js', 'film.json', 'source.mp4', 'source.srt', 'brief.txt', 'PLAN.md', 'timeline.json', 'review.md', 'validation.json', 'final.mp4']) {
    await add(task, filename, `work/${taskId}/${filename}`, !['index.html', 'film.json', 'source.mp4', 'final.mp4'].includes(filename));
  }
  const film = JSON.parse(await readFile(entries.get(`work/${taskId}/film.json`)!, 'utf8'));
  if (!entries.has(`work/${taskId}/scene.mjs`) && !entries.has(`work/${taskId}/scene.js`)) throw new Error('Editable scene is missing.');
  for (const filename of ['foreground.mp4', 'alpha.mp4', 'matting.json']) await add(task, `person/${filename}`, `work/${taskId}/person/${filename}`, !!film.keepBackground || filename === 'matting.json');
  // Asset folders contain media only; arbitrary JSON, scripts, provider replies and frame caches are excluded.
  async function assets(relative: string): Promise<void> {
    const directory = path.join(task, relative);
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const name of names.sort()) {
      const rel = path.join(relative, name), info = await lstat(path.join(task, rel));
      if (name.startsWith('.') || privateName.test(name)) continue;
      if (info.isDirectory()) {
        if (!within(task, await realpath(path.join(task, rel)))) throw new Error('Project asset leaves its task boundary.');
        await assets(rel);
      } else if (media.test(name)) await add(task, rel, `work/${taskId}/${rel}`);
    }
  }
  await assets('assets');
  for (const filename of await readdir(task)) {
    if (media.test(filename) && !/^(?:final\.|source\.|.*\.before-|.*\.pending\.)/.test(filename)) await add(task, filename, `work/${taskId}/${filename}`);
  }
  const fonts = path.join(root, 'reference-library', 'typography');
  for (const value of Object.values(film.style?.typography ?? {})) {
    if (typeof value === 'string' && value.startsWith('reference-library/typography/')) {
      await add(fonts, path.relative(fonts, path.join(root, value)), value);
      const license = path.join(path.dirname(value), 'OFL.txt');
      await add(fonts, path.relative(fonts, path.join(root, license)), license, true);
    }
  }
  const inputsPath = path.join(root, 'inputs', 'studio', taskId);
  for (const filename of ['source.mp4', 'voice.wav', 'narration.txt', 'subtitles.txt']) await add(inputsPath, filename, `inputs/studio/${taskId}/${filename}`, true);
  const rules = path.join(inputsPath, 'rules');
  if (await stat(rules).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
    await add(rules, '.agents', '.agents');
    await add(rules, 'AGENTS.md', 'AGENTS.md');
    await add(inputsPath, 'rules', `inputs/studio/${taskId}/rules`);
    await add(plugin, 'scripts/read-stage.mjs');
  }
  for (const filename of ['serve.mjs', 'scripts/render-project.mjs', 'scripts/browser.mjs', 'scripts/media-tools.mjs', 'scripts/runtime.mjs', 'LICENSE', 'NOTICE', 'COMMERCIAL-LICENSE.md', 'THIRD_PARTY_NOTICES.md']) await add(plugin, filename);
  for (const dependency of ['three', 'playwright-core']) {
    const directory = path.join(root, 'node_modules', dependency);
    for (const filename of dependency === 'three' ? ['build', 'package.json', 'LICENSE'] : await readdir(directory)) await add(directory, filename, `node_modules/${dependency}/${filename}`);
  }
  const signature = createHash('sha256');
  for (const [name, source] of entries) { const info = await stat(source); signature.update(JSON.stringify([name, info.size, info.mtimeMs])); }
  const digest = signature.digest('hex'), output = path.join(task, 'project.zip'), previous = cache.get(task);
  if (previous?.signature === digest && await realpath(output).then(file => within(task, file), () => false)) return output;
  const temporary = await mkdtemp(path.join(task, '.project-export-'));
  try {
    const stage = path.join(temporary, 'project');
    for (const [name, source] of entries) { const destination = path.join(stage, name); await mkdir(path.dirname(destination), { recursive: true }); await copyFile(source, destination); }
    await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'agent-motion-editable-film', private: true, type: 'module', engines: { node: '>=22' }, scripts: { serve: 'node serve.mjs', render: `node work/${taskId}/render.mjs` } }, null, 2) + '\n');
    await writeFile(path.join(stage, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=work/${taskId}/index.html"><a href="work/${taskId}/index.html">打开影片预览</a></html>`);
    await writeFile(path.join(stage, 'work', taskId, 'render.mjs'), `import {renderProject} from '../../scripts/render-project.mjs';import{fileURLToPath}from'node:url';await renderProject(fileURLToPath(new URL('.',import.meta.url)));\n`);
    await writeFile(path.join(stage, 'README.md'), `# 可编辑 Three.js 影片\n\n解压整个 ZIP，使用 Node.js 22/24 在根目录运行 \`npm run serve\`，打开终端给出的本地地址。HTML、字体、Three.js 和人物素材均在包内，预览无需云 API 或联网；浏览器的 file:// 模式无法加载 ES 模块和素材，请使用本地服务。\n\n编辑 work/${taskId}/scene.mjs（或 scene.js）、film.json、source.srt 及 assets。重新渲染前将已有 final.mp4 重命名，然后运行 \`npm run render\`；不会覆盖已有成片。人物抠图结果可直接复用，原人物视频与生成配音保存在 inputs/studio/${taskId}/。\n\n重新渲染需要 FFmpeg、FFprobe 和 Chromium：默认读取系统 PATH 与 Playwright 已安装的浏览器。可通过 FFMPEG_PATH、FFPROBE_PATH、BROWSER_EXECUTABLE 指定程序路径，或 BROWSER_CHANNEL=msedge/chrome 使用本机浏览器；也可运行 \`node node_modules/playwright-core/cli.js install chromium\` 下载 Chromium。包不含操作系统专属运行环境或任何云凭据。\n\n如存在 inputs/studio/${taskId}/rules，那里是本片实际使用的 Skill 规则快照；可通过 \`node scripts/read-stage.mjs --rules-root inputs/studio/${taskId}/rules --stage composition --kind talking-head\` 读取，规则阅读需要 Python 3.10+。原项目和字体许可随包保留；发布前仍需实际观看与试听。\n`);
    const managed = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const python = await stat(managed).then(() => ({ command: managed, prefix: [] as string[] }), () => findPython());
    const archive = path.join(temporary, 'project.zip');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(python.command, [...python.prefix, '-c', 'import pathlib,sys,zipfile\nr=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2], "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:\n for p in sorted(r.rglob("*")):\n  if p.is_file(): z.write(p,p.relative_to(r).as_posix())', stage, archive], { windowsHide: true, stdio: 'ignore' });
      child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('Project ZIP creation failed.')));
    });
    await rename(archive, output);
    cache.set(task, { signature: digest, output });
    return output;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
