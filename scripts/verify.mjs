import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, createReadStream, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { findSource, projectRoot } from './recover.mjs';

const output = process.argv[3] ? resolve(process.argv[3]) : join(projectRoot, 'recovered');
const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'));
const source = process.argv[2] ? resolve(process.argv[2]) : report.source.snapshot && existsSync(join(output, report.source.snapshot)) ? join(output, report.source.snapshot) : findSource();
const hash = createHash('sha256');
for await (const chunk of createReadStream(source)) hash.update(chunk);
assert.equal(hash.digest('hex'), report.source.sha256, '源文件 SHA-256 不匹配');
const input = new DatabaseSync(source, { readOnly: true }), target = new DatabaseSync(join(output, 'archive.sqlite'), { readOnly: true });
try {
  const chunks = input.prepare('SELECT chunkIndex,chunk FROM DBMessageChunk WHERE messageId=? ORDER BY chunkIndex');
  const recovered = target.prepare('SELECT raw_json,chunk_count,byte_length FROM messages WHERE id=?');
  let messages = 0, byteCount = 0, chunkCount = 0;
  for (const row of input.prepare('SELECT id FROM DBMessage').iterate()) {
    const parts = chunks.all(row.id), bytes = Buffer.concat(parts.map(p => Buffer.from(p.chunk))), actual = recovered.get(row.id);
    assert.ok(actual, `消息未导出：${row.id}`);
    // Failed messages are audited through report/unparsed rather than pretending they parsed successfully.
    if (!report.issues.some(i => i.type === 'message' && i.id === row.id)) assert.deepEqual(JSON.parse(actual.raw_json), JSON.parse(bytes.toString('utf8')), `原始消息不一致：${row.id}`);
    assert.equal(actual.chunk_count, parts.length); assert.equal(actual.byte_length, bytes.length);
    messages++; byteCount += bytes.length; chunkCount += parts.length;
  }
  let exportedMessages = 0;
  for (const conv of target.prepare('SELECT id,message_count,export_name,raw_json FROM conversations').iterate()) {
    const file = JSON.parse(readFileSync(join(output, 'conversations', `${conv.export_name}.json`), 'utf8'));
    assert.equal(file.id, conv.id); assert.equal(file.messages.length, conv.message_count);
    const ids = new Set();
    for (const m of file.messages) {
      assert.ok(!ids.has(m.id), `重复消息：${m.id}`); ids.add(m.id);
      assert.deepEqual(m.raw, JSON.parse(recovered.get(m.id).raw_json));
    }
    exportedMessages += file.messages.length;
  }
  assert.equal(messages, report.counts.sourceMessages);
  assert.equal(exportedMessages, report.counts.messages);
  assert.equal(chunkCount, report.counts.sourceChunks - (report.counts.orphanChunkMessages ? input.prepare('SELECT count(*) AS n FROM DBMessageChunk ch WHERE NOT EXISTS(SELECT 1 FROM DBMessage m WHERE m.id=ch.messageId)').get().n : 0));
  console.log(`核验通过：${messages} 条源消息逐条一致，${exportedMessages} 条 JSON 导出完整，${chunkCount} 个源消息数据块 / ${byteCount} 字节。源文件 SHA-256 一致。`);
} finally { input.close(); target.close(); }
