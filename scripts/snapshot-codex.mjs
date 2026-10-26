import { existsSync, readdirSync, mkdirSync, copyFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { projectRoot } from './recover.mjs';

// Filesystem copies only. Never opens original databases through SQLite/LevelDB.
const home = homedir(), web = join(home, 'AppData/Roaming/Codex/web/Codex');
const output = join(projectRoot, 'codex-snapshots', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(output, { recursive: true });
const manifest = { createdAt: new Date().toISOString(), output, files: [], errors: [], notes: [
  'Live filesystem copy; original databases were not opened or modified by this script.',
  'Main databases and available WAL/SHM files were copied. A running app may change files during copying; validate the snapshot before use.',
] };
function copy(source, target) {
  if (!existsSync(source)) return;
  if (!resolve(target).startsWith(resolve(output) + '\\') && !resolve(target).startsWith(resolve(output) + '/')) throw new Error('Invalid snapshot destination');
  try {
    const before = statSync(source);
    if (before.isDirectory()) {
      mkdirSync(target, { recursive: true });
      for (const item of readdirSync(source, { withFileTypes: true })) {
        if (item.isSymbolicLink() || item.name === 'LOCK' || item.name === 'lockfile') continue;
        copy(join(source, item.name), join(target, item.name));
      }
    } else if (before.isFile()) {
      mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target);
      const after = statSync(source);
      manifest.files.push({ source, path: relative(output, target), bytes: statSync(target).size, changedDuringCopy: before.size !== after.size || before.mtimeMs !== after.mtimeMs });
    }
  } catch (e) { manifest.errors.push({ source, error: e.code || e.message }); }
}
for (const [source, name] of [
  [join(home, '.codex/state_5.sqlite'), 'state_5.sqlite'],
  [join(home, '.codex/thread_history_1.sqlite'), 'thread_history_1.sqlite'],
  [join(home, '.codex/sqlite/codex-dev.db'), 'codex-dev.db'],
]) {
  copy(source, join(output, name));
  copy(source + '-wal', join(output, name + '-wal'));
  copy(source + '-shm', join(output, name + '-shm'));
}
copy(join(home, '.codex/.codex-global-state.json'), join(output, 'global-state.json'));
copy(join(home, '.codex/.codex-global-state.json.bak'), join(output, 'global-state.backup.json'));
for (const name of ['IndexedDB', 'Local Storage', 'Session Storage', 'Cache']) copy(join(web, 'Default', name), join(output, 'profile', name));
writeFileSync(join(output, 'snapshot-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ output, copiedFiles: manifest.files.length, bytes: manifest.files.reduce((n, f) => n + f.bytes, 0), changedDuringCopy: manifest.files.filter(f => f.changedDuringCopy).length, errors: manifest.errors }, null, 2));
