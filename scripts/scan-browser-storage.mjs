import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { walkFiles } from '../lib/cache-recovery.mjs';
import { levelRecords } from '../lib/leveldb-read.mjs';

if (!process.argv[2]) throw new Error('请指定浏览器缓存副本目录');
const root = resolve(process.argv[2]);
const index = JSON.parse(readFileSync(new URL('../recovered/index.json', import.meta.url), 'utf8'));
const missing = index.filter(c => !c.messageCount);
const ids = missing.map(c => ({ ...c, ascii: Buffer.from(c.id), utf16: Buffer.from(c.id, 'utf16le') }));
const report = { snapshot: root, files: 0, records: 0, errors: [], hits: [] };
for (const file of walkFiles(root)) {
  if (!/(?:IndexedDB|Local Storage|Session Storage)[\\/].*\.(ldb|sst|log)$/.test(file)) continue;
  report.files++;
  try {
    let ordinal = 0;
    for (const { key, value } of levelRecords(file)) {
      report.records++; ordinal++;
      for (const id of ids) {
        if (key.includes(id.ascii) || value.includes(id.ascii) || key.includes(id.utf16) || value.includes(id.utf16)) report.hits.push({ conversationId: id.id, title: id.title, file: relative(root, file), ordinal, keyBytes: key.length, valueBytes: value.length });
      }
    }
  } catch (e) { report.errors.push({ file: relative(root, file), error: e.message }); }
}
writeFileSync(join(root, 'browser-storage-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
