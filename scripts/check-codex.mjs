import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib';

if (!process.argv[2]) throw new Error('用法：node scripts/check-codex.mjs codex-snapshots/副本目录');
const root = resolve(process.argv[2]);
const index = JSON.parse(readFileSync(new URL('../recovered/index.json', import.meta.url), 'utf8'));
const empty = index.filter(c => !c.messageCount);
const ids = new Map(index.map(c => [c.id, c]));
const matches = new Map(empty.map(c => [c.id, { id: c.id, title: c.title, catalog: [], threadHistory: false, cacheFiles: [] }]));
const report = { checkedAt: new Date().toISOString(), snapshot: root, snapshotOnly: true, missingConversations: empty.length, databases: [], cache: {}, matches: [] };
for (const name of ['state_5.sqlite', 'thread_history_1.sqlite', 'codex-dev.db']) {
  const db = new DatabaseSync(join(root, name), { readOnly: true });
  try {
    const info = { file: name, integrity: db.prepare('PRAGMA quick_check').all().map(r => Object.values(r)[0]) };
    if (name === 'state_5.sqlite') {
      const rows = db.prepare('SELECT id,title FROM threads').all();
      info.threads = rows.length; info.matchingIds = rows.filter(r => ids.has(r.id)).length;
      info.missingTitleMatches = rows.filter(r => empty.some(c => c.title === r.title)).length;
    } else if (name === 'thread_history_1.sqlite') {
      const rows = db.prepare('SELECT thread_id,count(*) AS items FROM thread_items GROUP BY thread_id').all();
      info.threads = rows.length; info.matchingIds = rows.filter(r => ids.has(r.thread_id)).length;
      for (const row of rows) if (matches.has(row.thread_id)) matches.get(row.thread_id).threadHistory = true;
    } else {
      const rows = db.prepare('SELECT host_id,thread_id,display_title FROM local_thread_catalog').all();
      info.catalogEntries = rows.length; info.matchingIds = rows.filter(r => ids.has(r.thread_id)).length;
      info.missingIdMatches = rows.filter(r => matches.has(r.thread_id)).length;
      for (const row of rows) if (matches.has(row.thread_id)) matches.get(row.thread_id).catalog.push({ host: row.host_id, title: row.display_title });
      info.ledger = db.prepare('SELECT host_id,count(*) AS count FROM thread_timeline_ledger GROUP BY host_id').all();
    }
    report.databases.push(info);
  } finally { db.close(); }
}
let files = 0, bytes = 0, decoded = 0;
const scanned = new Set();
function scanBuffer(buffer, file) {
  for (const [id, entry] of matches) {
    if ((buffer.includes(Buffer.from(id)) || buffer.includes(Buffer.from(id, 'utf16le'))) && !entry.cacheFiles.includes(file)) entry.cacheFiles.push(file);
  }
}
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) { walk(file); continue; }
    if (!entry.isFile()) continue;
    const data = readFileSync(file); files++; bytes += data.length;
    const display = file.slice(root.length + 1); scanBuffer(data, display);
    // Simple Cache stores the URL key before response stream data. Try whole files
    // and stream payloads for common HTTP encodings, never the live profile.
    const candidates = [data];
    if (data.length > 24) {
      const keyLength = data.readUInt32LE(12);
      if (keyLength > 0 && keyLength < 65536 && keyLength + 24 < data.length) candidates.push(data.subarray(24 + keyLength));
    }
    for (const candidate of candidates) {
      for (const decompress of [gunzipSync, inflateSync, brotliDecompressSync]) {
        try {
          const decodedData = decompress(candidate, { maxOutputLength: 128 * 1024 * 1024 });
          if (decodedData.length) { decoded++; scanBuffer(decodedData, display + ' (decompressed)'); }
        } catch { /* Most cache entries are plain bytes, not compressed streams. */ }
      }
    }
  }
}
walk(join(root, 'profile'));
report.cache = { files, bytes, decompressedStreams: decoded };
report.matches = [...matches.values()];
report.summary = {
  catalogOnlyCandidates: report.matches.filter(m => m.catalog.length).length,
  matchingThreadHistories: report.matches.filter(m => m.threadHistory).length,
  missingConversationCacheHits: report.matches.filter(m => m.cacheFiles.length).length,
};
report.notes = ['目录标题/会话 ID 命中不等于正文存在。', '快照主库连同可用 WAL 一起读取；检查后未连接原始 Codex 数据库。', '缓存扫描包括 UTF-8/UTF-16LE ID 和可识别的压缩流；未保证解析所有浏览器内部压缩格式。'];
writeFileSync(join(root, 'matching-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ databases: report.databases, cache: report.cache, summary: report.summary, report: join(root, 'matching-report.json') }, null, 2));
