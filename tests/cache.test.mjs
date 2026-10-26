import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { recover } from '../scripts/recover.mjs';
import { snappy, levelRecords } from '../lib/leveldb-read.mjs';
import { readCacheConversations } from '../lib/cache-recovery.mjs';

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'chat-cache-test-'));
  t.after(() => { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('chat-cache-test-')); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
test('Snappy handles overlapping copies and rejects corrupt input', () => {
  assert.equal(snappy(Buffer.from([11, 8, ...Buffer.from('xab'), 17, 2])).toString(), 'xababababab');
  assert.equal(snappy(Buffer.from([7, 8, ...Buffer.from('xab'), 14, 2, 0])).toString(), 'xababab');
  assert.equal(snappy(Buffer.from([7, 8, ...Buffer.from('xab'), 15, 2, 0, 0, 0])).toString(), 'xababab');
  assert.throws(() => snappy(Buffer.from([10, 1, 255])), /Invalid copy/);
  assert.throws(() => snappy(Buffer.from([100, 0])), /Invalid literal/);
});
test('LevelDB reads SSTable entries and joins fragmented WAL records', t => {
  const dir = temp(t);
  const vi = n => { const bytes = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; bytes.push(b); } while (n); return Buffer.from(bytes); };
  const block = (key, value) => Buffer.concat([vi(0), vi(key.length), vi(value.length), key, value, Buffer.alloc(4), Buffer.from([1, 0, 0, 0])]);
  const data = block(Buffer.from('conversation'), Buffer.from('中文缓存记录'));
  const index = block(Buffer.from('z'), Buffer.concat([vi(0), vi(data.length)]));
  const footer = Buffer.alloc(48), handles = Buffer.concat([vi(0), vi(0), vi(data.length + 5), vi(index.length)]);
  handles.copy(footer); footer.writeBigUInt64LE(0xdb4775248b80fb57n, 40);
  const table = join(dir, 'test.ldb');
  writeFileSync(table, Buffer.concat([data, Buffer.alloc(5), index, Buffer.alloc(5), footer]));
  const records = [...levelRecords(table)]; assert.equal(records.length, 1); assert.equal(records[0].value.toString(), '中文缓存记录');
  const payload = Buffer.from('跨片段'.repeat(5000));
  const log = []; let offset = 0;
  while (offset < payload.length) {
    const size = Math.min(32761, payload.length - offset), header = Buffer.alloc(7);
    header.writeUInt16LE(size, 4); header[6] = offset === 0 ? 2 : offset + size === payload.length ? 4 : 3;
    log.push(header, payload.subarray(offset, offset + size)); offset += size;
  }
  const path = join(dir, 'test.log'); writeFileSync(path, Buffer.concat(log));
  assert.deepEqual([...levelRecords(path)][0].value, payload);
});
test('legacy inline Brotli cache restores missing conversation and deduplicates messages', t => {
  const dir = temp(t), cache = join(dir, 'snapshot', 'Cache_Data'); mkdirSync(cache, { recursive: true });
  const body = { conversation_id: 'conv', title: '缓存补回测试', messages: [
    { id: 'same', author: { role: 'user' }, create_time: 100, content: { content_type: 'text', parts: ['cache variation'] } },
    { id: 'new', author: { role: 'assistant' }, create_time: 101, content: { content_type: 'text', parts: ['缓存中的正文'] } },
  ], page_info: { has_previous_page: true, has_next_page: false } };
  const payload = brotliCompressSync(Buffer.from(JSON.stringify(body)));
  assert.ok(payload.length < 1024);
  const data1 = Buffer.alloc(8192 + 256), data2 = Buffer.alloc(8192 + 1024);
  for (const [file, size] of [[data1, 256], [data2, 1024]]) { file.writeUInt32LE(0xc104cac3, 0); file.writeUInt32LE(size, 12); }
  const key = Buffer.from('https://chatgpt.com/backend-api/conversation/conv');
  data1.writeUInt32LE(123, 8192); data1.writeInt32LE(key.length, 8192 + 32); key.copy(data1, 8192 + 96);
  data1.writeInt32LE(payload.length, 8192 + 44); data1.writeUInt32LE(0xb0020000, 8192 + 60); payload.copy(data2, 8192);
  writeFileSync(join(cache, 'data_1'), data1); writeFileSync(join(cache, 'data_2'), data2);
  const entries = readCacheConversations(join(dir, 'snapshot')); assert.equal(entries.get('conv').messages.size, 2);
  writeFileSync(join(dir, 'snapshot', 'extra.conversation.json'), JSON.stringify({ conversation_id: 'cache-only', title: '测试', messages: [{ id: 'separate-message', author: { role: 'user' }, content: { parts: ['相同标题的独立会话'] } }] }));
  const source = join(dir, 'phone.db'), db = new DatabaseSync(source);
  db.exec('CREATE TABLE DBConversation(id TEXT,conversation TEXT);CREATE TABLE DBMessage(id TEXT,conversationId TEXT);CREATE TABLE DBMessageChunk(messageId TEXT,chunkIndex INTEGER,chunk BLOB);');
  db.prepare('INSERT INTO DBConversation VALUES(?,?)').run('conv', JSON.stringify({ title: '测试' }));
  db.prepare('INSERT INTO DBMessage VALUES(?,?)').run('same', 'conv');
  const original = { id: 'same', role: 'User', content: { type: 'markdown', content: '手机原文' } };
  db.prepare('INSERT INTO DBMessageChunk VALUES(?,?,?)').run('same', 0, Buffer.from(JSON.stringify(original))); db.close();
  const out = join(dir, 'out'), report = recover({ source, output: out, cacheSnapshots: [join(dir, 'snapshot')], log: () => {} });
  assert.equal(report.counts.messages, 3); assert.equal(report.counts.supplementalMessages, 2);
  assert.equal(report.counts.sourceConversations, 1); assert.equal(report.counts.cacheOnlyConversations, 1); assert.equal(report.counts.restoredEmptyConversations, 0);
  const archive = new DatabaseSync(join(out, 'archive.sqlite'), { readOnly: true });
  try {
    assert.deepEqual(JSON.parse(archive.prepare('SELECT raw_json FROM messages WHERE id=?').get('same').raw_json), original);
    assert.equal(archive.prepare('SELECT text FROM messages WHERE id=?').get('new').text, '缓存中的正文');
    assert.equal(JSON.parse(archive.prepare('SELECT recovery_json FROM conversations WHERE id=?').get('conv').recovery_json).cachedPagePartial, true);
    assert.equal(readFileSync(join(out, report.source.snapshot)).length, readFileSync(source).length);
  } finally { archive.close(); }
});
