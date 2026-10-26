import { DatabaseSync } from 'node:sqlite';
import { readdirSync, mkdirSync, writeFileSync, statSync, existsSync, renameSync, openSync, readSync, closeSync, copyFileSync } from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { normalizeMessage, orderMessages } from '../lib/content.mjs';
import { readCacheConversations, adaptCachedMessage } from '../lib/cache-recovery.mjs';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
function sha256(path) {
  const hash = createHash('sha256'), fd = openSync(path, 'r'), buffer = Buffer.allocUnsafe(1024 * 1024);
  try { let n; while ((n = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n)); }
  finally { closeSync(fd); }
  return hash.digest('hex');
}
function iso(value) {
  const n = typeof value === 'number' ? value * 1000 : Date.parse(value);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}
export function findSource(root = projectRoot) {
  const files = readdirSync(root, { withFileTypes: true }).filter(f => f.isFile() && /\.(db|sqlite|sqlite3)$/i.test(f.name)).map(f => join(root, f.name));
  if (files.length !== 1) throw new Error(`目录中找到 ${files.length} 个数据库，请通过 --db "路径" 明确指定源文件。`);
  return files[0];
}

export function recover({ source = findSource(), output = join(projectRoot, 'recovered'), force = false, cacheSnapshots = [], log = console.log } = {}) {
  source = resolve(source); output = resolve(output);
  if (source === output || source.startsWith(output + '/') || source.startsWith(output + '\\')) throw new Error('输出目录不能包含源数据库。');
  if (existsSync(output) && !force) throw new Error(`输出目录已存在：${output}。使用 --force 重新恢复，旧目录会备份保留。`);
  const start = performance.now(), sourceStat = statSync(source), sourceHash = sha256(source);
  const staging = `${output}.building-${Date.now()}-${process.pid}`;
  mkdirSync(join(staging, 'conversations'), { recursive: true });
  mkdirSync(join(staging, 'markdown'));
  mkdirSync(join(staging, 'source'));
  const sourceCopy = join(staging, 'source', basename(source));
  copyFileSync(source, sourceCopy);
  const sidecars = [];
  for (const suffix of ['-wal', '-shm']) if (existsSync(source + suffix)) {
    copyFileSync(source + suffix, sourceCopy + suffix);
    sidecars.push({ name: basename(source) + suffix, bytes: statSync(sourceCopy + suffix).size, sha256: sha256(sourceCopy + suffix) });
  }
  // SQLite is only connected to our copied input, including any copied WAL.
  const input = new DatabaseSync(sourceCopy, { readOnly: true });
  let target;
  const issues = [];
  try {
    const cacheConversations = new Map();
    for (const snapshot of cacheSnapshots) {
      log(`正在读取缓存副本：${snapshot}`);
      for (const [id, entry] of readCacheConversations(resolve(snapshot))) {
        entry.pages = entry.pages.map(p => ({ ...p, snapshot: resolve(snapshot) }));
        const old = cacheConversations.get(id);
        if (!old) cacheConversations.set(id, entry);
        else { for (const [mid, message] of entry.messages) if (!old.messages.has(mid)) old.messages.set(mid, message); old.pages.push(...entry.pages); }
      }
    }
    input.exec('BEGIN');
    const integrity = input.prepare('PRAGMA quick_check').all().map(r => Object.values(r)[0]);
    if (integrity.some(v => v !== 'ok')) issues.push({ type: 'integrity', details: integrity });
    for (const table of ['DBConversation', 'DBMessage', 'DBMessageChunk']) {
      if (!input.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error(`不支持的数据库结构：缺少 ${table}`);
    }
    target = new DatabaseSync(join(staging, 'archive.sqlite'));
    target.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=NORMAL;
      CREATE TABLE conversations(id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT, message_count INTEGER, visible_count INTEGER, preview TEXT, export_name TEXT UNIQUE, raw_json TEXT, recovery_json TEXT);
      CREATE TABLE messages(rowid INTEGER PRIMARY KEY, id TEXT UNIQUE, conversation_id TEXT, seq INTEGER, parent_id TEXT, role TEXT, channel TEXT, model TEXT, content_type TEXT, created_at TEXT, hidden INTEGER, detail INTEGER, text TEXT, assets_json TEXT, chunk_count INTEGER, byte_length INTEGER, siblings INTEGER, raw_json TEXT);
      CREATE UNIQUE INDEX messages_conversation_seq ON messages(conversation_id, seq);
      CREATE INDEX messages_visible ON messages(conversation_id, detail, seq);
      CREATE INDEX conversations_date ON conversations(updated_at DESC, id);
      CREATE VIRTUAL TABLE message_search USING fts5(text, content='messages', content_rowid='rowid', tokenize='trigram');
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT);
      BEGIN;`);
    const insertConv = target.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?,?,?,?,?)');
    const insertMessage = target.prepare('INSERT INTO messages(id,conversation_id,seq,parent_id,role,channel,model,content_type,created_at,hidden,detail,text,assets_json,chunk_count,byte_length,siblings,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const getMessages = input.prepare('SELECT id,conversationId FROM DBMessage WHERE conversationId=? ORDER BY id');
    const getChunks = input.prepare('SELECT chunkIndex,chunk FROM DBMessageChunk WHERE messageId=? ORDER BY chunkIndex');
    const conversations = input.prepare('SELECT id,conversation FROM DBConversation ORDER BY id').all();
    const sourceConversationCount = conversations.length;
    const knownConversationIds = new Set(conversations.flatMap(c => {
      try { return [c.id, JSON.parse(c.conversation).remote_id].filter(Boolean); } catch { return [c.id]; }
    }));
    let cacheOnlyConversations = 0;
    for (const cached of cacheConversations.values()) {
      if (knownConversationIds.has(cached.id)) continue;
      const metadata = cached.pages.at(-1).payload;
      conversations.push({ id: cached.id, cacheOnly: true, conversation: JSON.stringify({ id: cached.id, title: cached.title || '浏览器缓存会话', creation_date: iso(metadata.create_time), modification_date: iso(metadata.update_time), recovered_from: 'browser-cache' }) });
      knownConversationIds.add(cached.id); cacheOnlyConversations++;
    }
    const orphanMessages = input.prepare('SELECT m.id,m.conversationId FROM DBMessage m LEFT JOIN DBConversation c ON c.id=m.conversationId WHERE c.id IS NULL').all();
    const orphanChunks = input.prepare('SELECT DISTINCT ch.messageId AS id FROM DBMessageChunk ch LEFT JOIN DBMessage m ON m.id=ch.messageId WHERE m.id IS NULL').all();
    const orphanGroups = new Map();
    for (const m of orphanMessages) {
      if (!orphanGroups.has(m.conversationId)) orphanGroups.set(m.conversationId, []);
      orphanGroups.get(m.conversationId).push(m);
    }
    if (orphanChunks.length) orphanGroups.set('__orphan_chunks__', orphanChunks);
    for (const id of orphanGroups.keys()) conversations.push({ id, conversation: JSON.stringify({ title: '未关联会话的消息', recovered_orphan: true }) });
    const counts = { conversations: conversations.length, sourceConversations: sourceConversationCount, cacheOnlyConversations,
      sourceMessages: input.prepare('SELECT count(*) AS n FROM DBMessage').get().n,
      sourceChunks: input.prepare('SELECT count(*) AS n FROM DBMessageChunk').get().n,
      messages: 0, parsedMessages: 0, failedMessages: 0, emptyConversations: 0, detailMessages: 0, assets: 0, bytes: 0, chunks: 0,
      orphanMessages: orphanMessages.length, orphanChunkMessages: orphanChunks.length, supplementalMessages: 0, supplementedConversations: 0, restoredEmptyConversations: 0 };
    const index = [];
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (const [conversationNumber, row] of conversations.entries()) {
      let conv;
      try { conv = JSON.parse(row.conversation); }
      catch { conv = { title: '会话元数据解析失败', original: row.conversation }; issues.push({ type: 'conversation-json', conversationId: row.id }); }
      const messages = [];
      for (const m of orphanGroups.get(row.id) || getMessages.all(row.id)) {
        const chunks = getChunks.all(m.id);
        const bytes = Buffer.concat(chunks.map(c => Buffer.from(c.chunk)));
        counts.bytes += bytes.length; counts.chunks += chunks.length;
        const gaps = chunks.some((c, i) => c.chunkIndex !== i);
        let raw, error;
        try {
          if (!chunks.length) throw new Error('没有消息数据块');
          if (gaps) throw new Error('数据块序号不连续');
          raw = JSON.parse(decoder.decode(bytes));
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('消息 JSON 不是对象');
          counts.parsedMessages++;
        } catch (e) {
          error = e.message; counts.failedMessages++;
          const rawName = createHash('sha256').update(m.id).digest('hex');
          mkdirSync(join(staging, 'unparsed'), { recursive: true });
          writeFileSync(join(staging, 'unparsed', `${rawName}.bin`), bytes);
          writeFileSync(join(staging, 'unparsed', `${rawName}.json`), JSON.stringify({ id: m.id, conversationId: row.id, error, chunks: chunks.map(c => ({ index: c.chunkIndex, base64: Buffer.from(c.chunk).toString('base64') })) }));
          issues.push({ type: 'message', id: m.id, conversationId: row.id, error, savedAs: `unparsed/${rawName}.json` });
          raw = { role: 'Unknown', content: { type: 'plain_text', content: `[恢复不完整：${error}]\n原始字节已保存在 unparsed/。` }, recovery_error: error };
        }
        if (raw.id && raw.id !== m.id) issues.push({ type: 'message-id-mismatch', id: m.id, payloadId: raw.id });
        if (raw.conversation_id && raw.conversation_id !== row.id) issues.push({ type: 'conversation-id-mismatch', id: m.id, payloadConversationId: raw.conversation_id, conversationId: row.id });
        messages.push({ ...normalizeMessage(raw, m.id, row.id, chunks.length, bytes.length), source: 'phone-database', raw });
      }
      const originalCount = messages.length;
      const cached = cacheConversations.get(row.id) || (conv.remote_id && cacheConversations.get(conv.remote_id));
      let recovery = { phoneMessages: originalCount, cacheOnly: !!row.cacheOnly, supplementalMessages: 0, cachePages: 0, cachedPagePartial: false };
      if (cached) {
        const knownIds = new Set(messages.flatMap(m => [m.id, m.raw.remote_message_id]).filter(Boolean));
        for (const raw of cached.messages.values()) {
          if (knownIds.has(raw.id)) continue;
          const adapted = adaptCachedMessage(raw, row.id);
          messages.push({ ...normalizeMessage(adapted, raw.id, row.id, 0, Buffer.byteLength(JSON.stringify(raw))), source: 'browser-cache', raw });
          recovery.supplementalMessages++; knownIds.add(raw.id);
        }
        recovery.cachePages = cached.pages.length;
        const hasCompletePage = cached.pages.some(p => p.payload.page_info && !p.payload.page_info.has_previous_page && !p.payload.page_info.has_next_page);
        const hasPartialPage = cached.pages.some(p => p.payload.page_info?.has_previous_page || p.payload.page_info?.has_next_page);
        recovery.cacheCoverage = hasCompletePage ? 'unpaginated-remainder' : hasPartialPage ? 'incomplete' : 'unknown';
        recovery.cachedPagePartial = !hasCompletePage;
        recovery.currentNode = cached.pages.at(-1)?.payload.current_node || null;
        mkdirSync(join(staging, 'cache-sources'), { recursive: true });
        const key = createHash('sha256').update(row.id).digest('hex').slice(0, 20);
        writeFileSync(join(staging, 'cache-sources', `${key}.json`), JSON.stringify({ conversationId: row.id, pages: cached.pages }, null, 2));
        recovery.sourceFile = `cache-sources/${key}.json`;
        counts.supplementalMessages += recovery.supplementalMessages;
        counts.supplementedConversations += +(recovery.supplementalMessages > 0);
        counts.restoredEmptyConversations += +(!row.cacheOnly && !originalCount && recovery.supplementalMessages > 0);
      }
      const ordered = orderMessages(messages);
      const exportName = `${String(conversationNumber + 1).padStart(4, '0')}-${createHash('sha256').update(row.id).digest('hex').slice(0, 12)}`;
      const firstText = ordered.find(m => !m.detail && m.text)?.text || ordered.find(m => m.text)?.text || '';
      const entry = {
        id: row.id, title: conv.title || '未命名会话', createdAt: iso(conv.creation_date),
        updatedAt: iso(conv.modification_date) || iso(conv.creation_date) || iso(ordered.at(-1)?.createdAt),
        messageCount: ordered.length, visibleCount: ordered.filter(m => !m.detail).length,
        preview: firstText.replace(/\s+/g, ' ').slice(0, 180), exportName, recovery,
      };
      insertConv.run(entry.id, entry.title, entry.createdAt, entry.updatedAt, entry.messageCount, entry.visibleCount, entry.preview, exportName, row.conversation, JSON.stringify(recovery));
      for (const m of ordered) {
        insertMessage.run(m.id, row.id, m.seq, m.parentId, m.role, m.channel, m.model, m.contentType,
          iso(m.createdAt), +m.hidden, +m.detail, m.text, JSON.stringify(m.assets), m.chunkCount, m.byteLength, m.siblings, JSON.stringify(m.raw));
        counts.messages++; counts.detailMessages += +m.detail; counts.assets += m.assets.length;
      }
      if (!ordered.length) counts.emptyConversations++;
      writeFileSync(join(staging, 'conversations', `${exportName}.json`), JSON.stringify({ ...entry, originalConversation: conv, messages: ordered }, null, 2));
      const markdown = [`# ${entry.title}`, '', `会话 ID：${entry.id}`, `消息数：${ordered.length}（包含工具、思考及隐藏消息）`,
        ...(recovery.supplementalMessages ? [`缓存补回：${recovery.supplementalMessages} 条消息${recovery.cachedPagePartial ? '。缓存分页不完整，可能缺失较早或较晚的消息。' : '。来源及原始响应保存在 cache-sources/。'}`] : []),
        ...(ordered.length ? [] : ['', '> 数据库只有会话标题和元数据，没有缓存消息正文。']), '',
        ...ordered.flatMap(m => [`---`, '', `## ${m.role}${m.channel ? ` · ${m.channel}` : ''}`, '',
          `${iso(m.createdAt) || '时间未知'} · ID: ${m.id}${m.detail ? ' · 详细消息' : ''}`, '', m.text || '（无文本内容）', '',
          ...m.assets.map(a => `附件引用：${a.name || a.kind} · ${a.asset_pointer || JSON.stringify(a)}`), ''])].join('\n');
      writeFileSync(join(staging, 'markdown', `${exportName}.md`), markdown);
      index.push(entry);
      if ((conversationNumber + 1) % 50 === 0) log(`已恢复 ${conversationNumber + 1}/${conversations.length} 个会话…`);
    }
    target.exec("INSERT INTO message_search(message_search) VALUES('rebuild'); COMMIT; PRAGMA optimize;");
    input.exec('COMMIT'); input.close();
    if (statSync(source).size !== sourceStat.size || sha256(source) !== sourceHash) issues.push({ type: 'source-changed', message: '恢复期间源数据库发生变化，导出来自读取事务快照。' });
    const report = {
      formatVersion: 2, recoveredAt: new Date().toISOString(), source: { name: basename(source), bytes: sourceStat.size, sha256: sourceHash, snapshot: `source/${basename(source)}`, sidecars }, cacheSnapshots: cacheSnapshots.map(p => resolve(p)),
      counts, integrity, issues, durationMs: Math.round(performance.now() - start),
      notes: ['只恢复数据库内现存记录，不包含云端未缓存或已删除的数据。', '空会话保留标题和元数据。', '附件引用不等于附件文件；未提供的图片、音频、文件不能凭引用离线还原。', '保留全部消息与父消息关联，不猜测客户端当前选中的分支。'],
    };
    target.prepare('INSERT INTO metadata VALUES(?,?)').run('report', JSON.stringify(report));
    target.close(); target = null;
    index.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '') || a.id.localeCompare(b.id));
    writeFileSync(join(staging, 'index.json'), JSON.stringify(index, null, 2));
    writeFileSync(join(staging, 'report.json'), JSON.stringify(report, null, 2));
    if (existsSync(output)) {
      const backup = `${output}.previous-${Date.now()}`;
      renameSync(output, backup); log(`旧输出已保留：${backup}`);
    }
    renameSync(staging, output);
    log(`恢复完成：${counts.conversations} 个会话，${counts.messages} 条消息，${counts.failedMessages} 条失败。耗时 ${report.durationMs} ms。\n输出：${output}`);
    return report;
  } catch (e) {
    try { input.close(); } catch {}
    try { target?.close(); } catch {}
    throw new Error(`${e.message}\n未发布的恢复数据保留于：${staging}`, { cause: e });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    const options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--force') options.force = true;
      else if (args[i] === '--db' || args[i] === '--out') {
        const name = args[i] === '--db' ? 'source' : 'output';
        if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${args[i]} 缺少路径`);
        options[name] = args[++i];
      } else if (args[i] === '--cache' && args[i + 1]) {
        (options.cacheSnapshots ||= []).push(args[++i]);
      } else if (args[i] === '--help') {
        console.log('node scripts/recover.mjs [--db 源数据库] [--out 输出目录] [--cache 浏览器缓存副本目录] [--force]'); process.exit(0);
      } else throw new Error(`未知参数：${args[i]}`);
    }
    recover(options);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
