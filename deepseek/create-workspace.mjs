import { cpSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const resources = [
  'AGENTS.md', 'LICENSE', 'NOTICE', 'COMMERCIAL-LICENSE.md', 'THIRD_PARTY_NOTICES.md',
  '.gitignore', '.agents', 'scripts', 'tests', 'serve.mjs', 'inputs/README.md',
  'deepseek/lib', 'deepseek/scene.mjs', 'templates',
  'reference-library/typography', 'reference-library/analysis',
  'docs/getting-started.md', 'docs/compatibility.md', 'docs/user-manual.md', 'docs/deployment.md', 'docs/image-generation.md',
];

/** Create a new production workspace; existing paths are never overwritten. */
export function createWorkspace(directory) {
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('Specify a new workspace directory.');
  const target = path.resolve(directory);
  const parent = realpathSync(path.dirname(target));
  const relative = path.relative(realpathSync(root), parent);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Create the production workspace outside the plugin installation directory.');
  }
  mkdirSync(target); // Exclusive creation also rejects existing directories and symlinks.
  for (const resource of resources) {
    const destination = path.join(target, resource);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(root, resource), destination, {
      recursive: true,
      filter(source) {
        if (source === path.join(root, '.agents', 'skills', 'agent-motion')) return false;
        if (lstatSync(source).isSymbolicLink()) throw new Error(`Symlink cannot be copied: ${source}`);
        return !/^(?:__pycache__|\.DS_Store)$|\.py[cod]$/.test(path.basename(source));
      },
    });
  }
  const { main, exports, dsh, files, peerDependencies, devDependencies, ...manifest } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  manifest.scripts = Object.fromEntries(Object.entries(manifest.scripts).filter(([name]) => !['test:plugin', 'build', 'prepack'].includes(name) && !name.startsWith('package:')));
  const lock = JSON.parse(readFileSync(path.join(root, 'npm-shrinkwrap.json'), 'utf8'));
  lock.packages = Object.fromEntries(Object.entries(lock.packages).filter(([name, entry]) => name === '' || (!entry.dev && !entry.peer)));
  const { devDependencies: lockDev, peerDependencies: lockPeers, ...production } = lock.packages[''];
  lock.packages[''] = production;
  for (const [name, value] of [['package.json', manifest], ['package-lock.json', lock]]) {
    writeFileSync(path.join(target, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  }
  mkdirSync(path.join(target, 'work'));
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node create-workspace.mjs <new-directory>');
    console.log(createWorkspace(process.argv[2]));
  } catch (error) {
    console.error(`Workspace creation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
