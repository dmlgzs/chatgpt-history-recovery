import { existsSync, readdirSync, mkdirSync, copyFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { projectRoot } from './recover.mjs';

const sourceRoot = join(homedir(), 'AppData/Local/Google/Chrome/User Data');
const output = join(projectRoot, 'codex-snapshots', `chrome-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(output, { recursive: true });
const manifest = { createdAt: new Date().toISOString(), sourceRoot, output, files: [], errors: [], profiles: [] };
function copy(source, target) {
  if (!existsSync(source)) return;
  if (!resolve(target).startsWith(resolve(output) + '\\') && !resolve(target).startsWith(resolve(output) + '/')) throw new Error('Invalid snapshot destination');
  try {
    const before = statSync(source);
    if (before.isDirectory()) {
      for (const entry of readdirSync(source, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || ['LOCK', 'lockfile'].includes(entry.name)) continue;
        copy(join(source, entry.name), join(target, entry.name));
      }
    } else if (before.isFile()) {
      mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target);
      const after = statSync(source);
      manifest.files.push({ source, path: relative(output, target), bytes: statSync(target).size, changedDuringCopy: before.size !== after.size || before.mtimeMs !== after.mtimeMs });
    }
  } catch (e) { manifest.errors.push({ source, error: e.code || e.message }); }
}
for (const profile of readdirSync(sourceRoot, { withFileTypes: true }).filter(d => d.isDirectory() && /^(Default|Profile \d+)$/.test(d.name))) {
  manifest.profiles.push(profile.name);
  for (const dir of ['Cache', 'Local Storage', 'Session Storage']) copy(join(sourceRoot, profile.name, dir), join(output, profile.name, dir));
  const indexed = join(sourceRoot, profile.name, 'IndexedDB');
  if (existsSync(indexed)) for (const entry of readdirSync(indexed)) {
    if (/chatgpt|openai/i.test(entry)) copy(join(indexed, entry), join(output, profile.name, 'IndexedDB', entry));
  }
  console.log(`已复制 ${profile.name} 的缓存副本。`);
}
writeFileSync(join(output, 'snapshot-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ output, profiles: manifest.profiles, files: manifest.files.length, bytes: manifest.files.reduce((n, f) => n + f.bytes, 0), changedDuringCopy: manifest.files.filter(f => f.changedDuringCopy).length, errors: manifest.errors }, null, 2));
