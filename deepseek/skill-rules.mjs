import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

function within(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Upgrade only an unchanged installed pager, before any paid service is submitted. */
export async function ensureRuleReader(workspace, pluginRoot) {
  const project = await realpath(workspace);
  const relative = '.agents/skills/motion-craft/scripts/read-stage.py';
  const target = path.join(project, relative);
  const metadata = path.join(project, '.agents/motion-craft-install.json');
  for (const file of [target, metadata]) {
    if ((await lstat(file)).isSymbolicLink() || !within(project, await realpath(file))) throw new Error('规则分页器或安装记录路径超出制作工程；尚未提交收费任务。');
  }
  const current = await readFile(target);
  const next = await readFile(path.join(pluginRoot, relative));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const currentHash = hash(current), nextHash = hash(next);
  const record = JSON.parse(await readFile(metadata, 'utf8'));
  const key = 'motion-craft/scripts/read-stage.py';
  if (!record.fileHashes || typeof record.fileHashes !== 'object') throw new Error('规则分页器安装记录无效；请合并 --rules-root 支持后修复记录，尚未提交收费任务。');
  if (currentHash !== nextHash) {
    if (record.fileHashes[key] !== currentHash) throw new Error('工程规则分页器已被用户修改，已保留原文件；请合并新版 --rules-root 支持并更新安装记录，尚未提交收费任务。');
    const backup = `${target}.pre-rules-upgrade-${currentHash}.bak`;
    try { await copyFile(target, backup, constants.COPYFILE_EXCL); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if ((await lstat(backup)).isSymbolicLink() || !within(project, await realpath(backup)) || !(await readFile(backup)).equals(current)) throw new Error('规则分页器备份已有不同内容，未覆盖工程；尚未提交收费任务。');
    }
    const pending = `${target}.${randomUUID()}.pending`;
    await writeFile(pending, next, { flag: 'wx' });
    await rename(pending, target);
  }
  if (record.fileHashes[key] !== nextHash) {
    record.fileHashes[key] = nextHash;
    const pending = `${metadata}.${randomUUID()}.pending`;
    await writeFile(pending, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    await rename(pending, metadata);
  }
}

/** Freeze the editable production rules for this job, without touching earlier jobs. */
export async function snapshotRules(workspace, pluginRoot, directory) {
  const project = await realpath(workspace);
  const parent = await realpath(path.dirname(directory));
  if (!within(project, parent)) throw new Error('Rule snapshot must stay inside the production workspace.');
  directory = path.join(parent, path.basename(directory));
  let existing;
  try { existing = await lstat(directory); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('Rule snapshot path is invalid.');
    // An aborted ready job can retry without paying again or changing its frozen rules.
    const record = JSON.parse(await readFile(path.join(directory, 'revision.json'), 'utf8'));
    if (!/^[a-f0-9]{64}$/.test(record.revision) || !Array.isArray(record.files)) throw new Error('Rule snapshot record is invalid.');
    const digest = createHash('sha256');
    for (const name of record.files) {
      if (typeof name !== 'string' || !within(directory, path.resolve(directory, name))) throw new Error('Rule snapshot file is invalid.');
      const file = await realpath(path.join(directory, name));
      if (!within(directory, file) || (await lstat(path.join(directory, name))).isSymbolicLink()) throw new Error('Rule snapshot file escaped its directory.');
      digest.update(name).update('\0').update(await readFile(file)).update('\0');
    }
    if (digest.digest('hex') !== record.revision) throw new Error('Frozen task rules were modified. Create a new task to use edited rules.');
    return record.revision;
  }
  const pending = path.join(parent, `${path.basename(directory)}.${randomUUID()}.pending`);
  await mkdir(pending);
  const digest = createHash('sha256');
  const files = [];
  async function copy(source, destination, boundary) {
    const info = await lstat(source);
    if (info.isSymbolicLink() || !within(boundary, await realpath(source))) throw new Error('Rule files cannot be symbolic links or escape their source directory.');
    if (info.isDirectory()) {
      await mkdir(destination, { recursive: true });
      for (const name of (await readdir(source)).sort()) {
        if (/^(?:__pycache__|\.DS_Store)$|\.py[cod]$/.test(name)) continue;
        await copy(path.join(source, name), path.join(destination, name), boundary);
      }
    } else if (info.isFile()) {
      const name = path.relative(pending, destination).split(path.sep).join('/');
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination, constants.COPYFILE_EXCL);
      const data = await readFile(destination);
      digest.update(name).update('\0').update(data).update('\0');
      files.push(name);
    } else throw new Error('Rule source must be a regular file or directory.');
  }
  try {
    await copy(path.join(project, 'AGENTS.md'), path.join(pending, 'AGENTS.md'), project);
    for (const name of ['motion-craft', 'srt-reference-to-three', 'agent-motion']) {
      const relative = `.agents/skills/${name}`;
      let source = path.join(project, relative), boundary = project;
      if (name === 'agent-motion' && !(await lstat(source).catch(error => { if (error.code !== 'ENOENT') throw error; }))) {
        boundary = await realpath(pluginRoot); source = path.join(boundary, relative);
      }
      await copy(source, path.join(pending, relative), boundary);
      if (!files.includes(`${relative}/SKILL.md`)) throw new Error(`Missing production skill: ${name}`);
    }
    const metadata = '.agents/motion-craft-install.json';
    if (await lstat(path.join(project, metadata)).catch(error => { if (error.code !== 'ENOENT') throw error; })) await copy(path.join(project, metadata), path.join(pending, metadata), project);
    const revision = digest.digest('hex');
    await writeFile(path.join(pending, 'revision.json'), JSON.stringify({ revision, files }, null, 2) + '\n', { flag: 'wx' });
    await rename(pending, directory);
    return revision;
  } catch (error) {
    // Only the exclusive temporary directory created by this call is removed.
    if (within(project, pending) && await realpath(pending) === pending) await rm(pending, { recursive: true });
    throw error;
  }
}
