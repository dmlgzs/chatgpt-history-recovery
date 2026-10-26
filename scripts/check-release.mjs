import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const allowedRoot = new Set(['.gitignore', '.npmignore', 'package.json', 'package-lock.json', 'README.md', 'LICENSE', 'server.mjs']);
// Local dependencies and Git metadata are not release source files.
const ignoredDirectories = new Set(['node_modules', '.git']);
const issues = [];
let checked = 0;
const rules = [
  ['个人 Windows 用户路径', /[A-Z]:[\\/]+Users[\\/]+[^\s"'`<>\\/]+/i],
  ['个人 Unix 主目录路径', /\/(?:home|Users)\/[a-zA-Z0-9_.-]+\//],
  ['真实格式的账户标识', /\buser-[a-zA-Z0-9]{12,}\b/],
  ['疑似 API Key', /\bsk-[a-zA-Z0-9_-]{20,}\b/],
  ['疑似 JWT', /\beyJ[a-zA-Z0-9_-]{16,}\.[a-zA-Z0-9_-]{16,}\.[a-zA-Z0-9_-]{16,}\b/],
];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name), name = relative(root, file).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) { issues.push(`${name}: 不应包含符号链接`); continue; }
    if (entry.isDirectory()) {
      if (dir === root && ignoredDirectories.has(entry.name)) continue;
      if (dir === root && !['lib', 'scripts', 'public', 'tests'].includes(entry.name)) { issues.push(`${name}/: 不在发布目录白名单内`); continue; }
      walk(file); continue;
    }
    const allowed = allowedRoot.has(name) || /^(?:lib|scripts)\/[a-z0-9-]+\.mjs$/.test(name) || /^tests\/[a-z0-9-]+\.test\.mjs$/.test(name) || /^public\/[a-z0-9-]+\.(?:js|css|html)$/.test(name);
    if (!allowed) { issues.push(`${name}: 不在发布文件白名单内`); continue; }
    checked++;
    const text = readFileSync(file, 'utf8');
    for (const [label, regex] of rules) if (regex.test(text)) issues.push(`${name}: ${label}`);
  }
}
walk(root);
if (issues.length) {
  console.error(`发布检查未通过（${issues.length} 项）：\n${issues.map(s => `- ${s}`).join('\n')}`);
  process.exitCode = 1;
} else console.log(`发布检查通过：${checked} 个源码文件，无白名单外数据文件或已检测的个人路径、账户标识、凭据形式。`);
