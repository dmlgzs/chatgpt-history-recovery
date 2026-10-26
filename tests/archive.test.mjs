import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { recover } from '../scripts/recover.mjs';
import { extractContent, orderMessages } from '../lib/content.mjs';
import { startServer } from '../server.mjs';

test('content extraction retains structured thoughts, multimodal references, and unknown objects', () => {
  assert.equal(extractContent({ type: 'structured_thoughts', thoughts: [{ summary: '思考', content: '分析过程' }] }).text, '### 思考\n\n分析过程');
  const mixed = extractContent({ type: 'multimodal', parts: [{ type: 'markdown', content: '正文' }, { type: 'image', content: { image_asset_pointer: { asset_pointer: 'file://abc', width: 100 } } }] });
  assert.equal(mixed.text, '正文'); assert.equal(mixed.assets[0].asset_pointer, 'file://abc');
  assert.match(extractContent({ special_unknown_payload: '不可丢弃' }).text, /不可丢弃/);
  assert.equal(extractContent({ type: 'developer_content', instructions: ['a', 'b'] }).text, 'a\n\nb');
});

test('parent ordering preserves branches, missing parents, and cyclic data', () => {
  const ordered = orderMessages([
    { id: 'child', parentId: 'root', createdAt: '2020-01-01' },
    { id: 'branch', parentId: 'root', createdAt: '2020-01-03' },
    { id: 'root', createdAt: '2020-01-02' },
    { id: 'cycle-a', parentId: 'cycle-b' }, { id: 'cycle-b', parentId: 'cycle-a' },
  ]);
  assert.equal(ordered.length, 5);
  assert.ok(ordered.findIndex(m => m.id === 'root') < ordered.findIndex(m => m.id === 'child'));
  assert.equal(ordered.find(m => m.id === 'child').siblings, 2);
});

test('recovery and HTTP API: split UTF-8, corrupt chunks, orphans, search and bounded pagination', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'chat-archive-test-'));
  let running;
  t.after(async () => {
    await running?.close();
    const path = resolve(temp);
    assert.equal(dirname(path), resolve(tmpdir()));
    assert.ok(basename(path).startsWith('chat-archive-test-'));
    rmSync(path, { recursive: true, force: true });
  });
  const source = join(temp, 'source.db'), output = join(temp, 'export');
  const db = new DatabaseSync(source);
  db.exec('CREATE TABLE DBConversation(id TEXT PRIMARY KEY,conversation TEXT); CREATE TABLE DBMessage(id TEXT PRIMARY KEY,conversationId TEXT); CREATE TABLE DBMessageChunk(messageId TEXT,chunkIndex INTEGER,chunk BLOB,PRIMARY KEY(messageId,chunkIndex));');
  const insertConv = db.prepare('INSERT INTO DBConversation VALUES(?,?)');
  insertConv.run('conv', JSON.stringify({ title: '测试中文会话', creation_date: '2025-01-01T00:00:00Z' }));
  insertConv.run('empty', JSON.stringify({ title: '没有正文' }));
  const insert = db.prepare('INSERT INTO DBMessage VALUES(?,?)'), chunk = db.prepare('INSERT INTO DBMessageChunk VALUES(?,?,?)');
  const add = (id, raw, conv = 'conv', index = 0) => {
    insert.run(id, conv); chunk.run(id, index, Buffer.from(JSON.stringify({ id, role: 'User', content: { type: 'markdown', content: `中文搜索词 English punctuation %_" ' ${id}` }, ...raw })));
  };
  for (let i = 0; i < 73; i++) add(`m-${i}`, { created_date: new Date(2025, 0, 1, 0, i).toISOString(), parent_id: i ? `m-${i - 1}` : undefined, is_visually_hidden_in_conversation: i % 7 === 0 });
  const utf8Raw = { id: 'split', role: 'Assistant', content: { type: 'markdown', content: '中🙂文 across chunks' } };
  const utf8 = Buffer.from(JSON.stringify(utf8Raw)), splitAt = utf8.indexOf(Buffer.from('🙂')) + 1;
  insert.run('split', 'conv'); chunk.run('split', 0, utf8.subarray(0, splitAt)); chunk.run('split', 1, utf8.subarray(splitAt));
  add('orphan', {}, 'missing-conversation');
  chunk.run('orphan-chunk', 0, Buffer.from(JSON.stringify({ role: 'User', content: { content: '孤立块仍应保存' } })));
  insert.run('no-chunks', 'conv');
  add('gap', {}, 'conv', 1);
  insert.run('bad-json', 'conv'); chunk.run('bad-json', 0, Buffer.from('{broken'));
  insert.run('invalid-utf8', 'conv'); chunk.run('invalid-utf8', 0, Buffer.from([0xff]));
  add('long', { content: { content: '超长消息'.repeat(15000) } });
  db.close();
  const originalHash = createHash('sha256').update(readFileSync(source)).digest('hex');
  const report = recover({ source, output, log: () => {} });
  assert.equal(report.counts.failedMessages, 4);
  assert.equal(report.counts.orphanMessages, 1); assert.equal(report.counts.orphanChunkMessages, 1);
  assert.equal(report.counts.messages, report.counts.sourceMessages + 1);
  assert.equal(report.counts.chunks, report.counts.sourceChunks);
  assert.equal(report.counts.emptyConversations, 1);
  assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), originalHash);
  const target = new DatabaseSync(join(output, 'archive.sqlite'), { readOnly: true });
  assert.deepEqual(JSON.parse(target.prepare('SELECT raw_json FROM messages WHERE id=?').get('split').raw_json), utf8Raw);
  assert.equal(target.prepare('SELECT text FROM messages WHERE id=?').get('split').text, '中🙂文 across chunks');
  assert.match(target.prepare('SELECT text FROM messages WHERE id=?').get('orphan-chunk').text, /孤立块/);
  for (const issue of report.issues.filter(i => i.type === 'message')) assert.ok(existsSync(join(output, issue.savedAs)));
  target.close();
  assert.throws(() => recover({ source, output, log: () => {} }), /已存在/);
  running = await startServer({ output, port: 0, autoRecover: false, quiet: true });
  const { address } = running;
  const get = async path => { const res = await fetch(address + path); assert.equal(res.status, 200, path); return res.json(); };
  assert.equal((await get('/api/stats')).counts.messages, report.counts.messages);
  const conversations = await get('/api/conversations?filter=empty'); assert.equal(conversations.items.length, 1);
  const ids = []; let after = -1;
  do {
    const page = await get(`/api/conversations/conv/messages?after=${after}&limit=10`);
    assert.ok(page.items.length <= 10);
    ids.push(...page.items.map(m => m.id));
    if (!page.hasAfter) break;
    after = page.items.at(-1).seq;
  } while (true);
  assert.equal(new Set(ids).size, ids.length); assert.equal(ids.length, report.counts.messages - 2);
  const page = await get('/api/conversations/conv/messages?around=m-50&details=1');
  assert.ok(page.items.some(m => m.id === 'm-50')); assert.ok(page.hasBefore);
  const prev = await get(`/api/conversations/conv/messages?before=${page.items[0].seq}&details=1`);
  assert.ok(prev.items.every(m => m.seq < page.items[0].seq));
  const visible = await get('/api/conversations/conv/messages?details=0&limit=60');
  assert.ok(visible.items.every(m => !m.detail));
  for (const q of ['中文搜索', '搜索', '文', 'English', '%_', '%_"', 'punctuation', '" OR 1=1 --']) {
    const result = await get(`/api/search?q=${encodeURIComponent(q)}`);
    assert.equal(result.items.length > 0, q !== '" OR 1=1 --', q);
  }
  const firstSearch = await get('/api/search?q=English&limit=10');
  const secondSearch = await get(`/api/search?q=English&limit=10&cursor=${firstSearch.nextCursor}`);
  assert.ok(secondSearch.items.every(m => !firstSearch.items.some(p => p.id === m.id)));
  const longPage = await get('/api/conversations/conv/messages?around=long');
  const long = longPage.items.find(m => m.id === 'long');
  assert.equal(long.text.length, 12000); assert.equal(long.truncated, true);
  const full = await get('/api/messages/long'); assert.equal(full.text.length, 60000); assert.equal(full.truncated, false);
  const conv = await get('/api/conversations/conv');
  const exportResponse = await fetch(address + '/api/export/conv/json');
  assert.equal(exportResponse.status, 200); assert.equal((await exportResponse.json()).messages.length, conv.messageCount);
  assert.equal((await fetch(address + '/api/messages/not-present')).status, 404);
  assert.equal((await fetch(address + '/api/stats', { method: 'POST' })).status, 405);
  assert.equal((await fetch(address + '/api/stats', { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(address + '/package.json')).status, 404);
  for (const file of ['/', '/app.js', '/style.css', '/vendor/marked.js', '/vendor/purify.js']) {
    const res = await fetch(address + file); assert.equal(res.status, 200, file);
    assert.ok(res.headers.get('content-security-policy').includes("connect-src 'self'"));
  }
});
