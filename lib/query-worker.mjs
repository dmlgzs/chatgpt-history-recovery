import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(workerData.database, { readOnly: true });
db.exec('PRAGMA query_only=ON; PRAGMA cache_size=-12000;');
const conversationColumns = `id,title,created_at AS createdAt,updated_at AS updatedAt,message_count AS messageCount,visible_count AS visibleCount,preview,export_name AS exportName,recovery_json AS recoveryJson`;
const messageColumns = `id,conversation_id AS conversationId,seq,parent_id AS parentId,role,channel,model,content_type AS contentType,created_at AS createdAt,hidden,detail,substr(text,1,12000) AS text,length(text) AS textLength,assets_json,chunk_count AS chunkCount,byte_length AS byteLength,siblings`;
function message(row) {
  const { assets_json, ...rest } = row;
  return { ...rest, assets: JSON.parse(assets_json), truncated: row.textLength > 12000 };
}
function conversation(row) {
  if (!row) return null;
  const { recoveryJson, ...rest } = row;
  return { ...rest, recovery: JSON.parse(recoveryJson || '{}') };
}
function count(n, max, fallback) { return Number.isInteger(Number(n)) && Number(n) >= 0 ? Math.min(Number(n), max) : fallback; }
function escapeLike(q) { return `%${q.replace(/[\\%_]/g, '\\$&')}%`; }
const operations = {
  stats() { return JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='report'").get().value); },
  conversations({ q = '', offset = 0, limit = 60, filter = 'all', sort = 'recent' }) {
    const conditions = [], values = [];
    if (q) { conditions.push("title LIKE ? ESCAPE '\\'"); values.push(escapeLike(q)); }
    if (filter === 'cached') conditions.push('message_count > 0');
    if (filter === 'empty') conditions.push('message_count = 0');
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const order = sort === 'oldest' ? 'updated_at ASC, id' : sort === 'messages' ? 'message_count DESC, updated_at DESC, id' : 'updated_at DESC, id';
    const rows = db.prepare(`SELECT ${conversationColumns} FROM conversations ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...values, count(limit, 100, 60) + 1, count(offset, 1e9, 0));
    const size = count(limit, 100, 60);
    return { items: rows.slice(0, size).map(conversation), hasMore: rows.length > size, total: db.prepare(`SELECT count(*) AS n FROM conversations ${where}`).get(...values).n };
  },
  conversation({ id }) { return conversation(db.prepare(`SELECT ${conversationColumns} FROM conversations WHERE id=?`).get(id)); },
  messages({ id, after = -1, before, limit = 24, details = '1', around }) {
    const conv = operations.conversation({ id });
    if (!conv) return null;
    const conditions = ['conversation_id=?'], values = [id];
    if (details === '0') conditions.push('detail=0');
    const total = db.prepare(`SELECT count(*) AS n FROM messages WHERE ${conditions.join(' AND ')}`).get(...values).n;
    let anchor = -1;
    if (around) {
      const found = db.prepare('SELECT seq FROM messages WHERE id=? AND conversation_id=?').get(around, id);
      if (found) {
        const prev = db.prepare(`SELECT seq FROM messages WHERE ${conditions.join(' AND ')} AND seq < ? ORDER BY seq DESC LIMIT 8`).all(...values, found.seq);
        anchor = prev.at(-1)?.seq ?? found.seq;
        conditions.push('seq >= ?'); values.push(anchor);
      }
    }
    const backwards = before != null && !around;
    if (anchor < 0) { conditions.push(backwards ? 'seq < ?' : 'seq > ?'); values.push(backwards ? count(before, 1e9, 0) : Math.max(-1, Number(after) || 0)); }
    const size = Math.max(1, count(limit, 60, 24));
    let rows = db.prepare(`SELECT ${messageColumns} FROM messages WHERE ${conditions.join(' AND ')} ORDER BY seq ${backwards ? 'DESC' : 'ASC'} LIMIT ?`).all(...values, size + 1);
    const hasMore = rows.length > size;
    rows = rows.slice(0, size);
    if (backwards) rows.reverse();
    const first = rows[0]?.seq, last = rows.at(-1)?.seq;
    const detailFilter = details === '0' ? 'AND detail=0' : '';
    return { items: rows.map(message), total, hasMore,
      hasBefore: first != null && !!db.prepare(`SELECT 1 FROM messages WHERE conversation_id=? ${detailFilter} AND seq < ? LIMIT 1`).get(id, first),
      hasAfter: last != null && !!db.prepare(`SELECT 1 FROM messages WHERE conversation_id=? ${detailFilter} AND seq > ? LIMIT 1`).get(id, last) };
  },
  message({ id }) {
    const row = db.prepare(`SELECT ${messageColumns},text,raw_json FROM messages WHERE id=?`).get(id);
    if (!row) return null;
    const { raw_json, ...rest } = row;
    return { ...message(rest), truncated: false, raw: JSON.parse(raw_json) };
  },
  search({ q = '', cursor, limit = 30, conversationId }) {
    q = q.trim().slice(0, 200);
    if (!q) return { items: [], hasMore: false };
    const conditions = [], values = [];
    // Trigram FTS handles Chinese/English substring searches; one/two characters fall back to LIKE.
    if ([...q].length >= 3) {
      conditions.push('m.rowid IN (SELECT rowid FROM message_search WHERE message_search MATCH ?)');
      values.push(`"${q.replaceAll('"', '""')}"`);
    }
    conditions.push("m.text LIKE ? ESCAPE '\\'"); values.push(escapeLike(q));
    if (cursor) { conditions.push('m.rowid < ?'); values.push(count(cursor, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)); }
    if (conversationId) { conditions.push('m.conversation_id=?'); values.push(conversationId); }
    const size = Math.max(1, count(limit, 60, 30));
    const rows = db.prepare(`SELECT m.rowid AS cursor,m.id,m.conversation_id AS conversationId,m.seq,m.role,m.channel,m.detail,c.title,
      substr(m.text,max(1,instr(lower(m.text),lower(?))-90),360) AS snippet
      FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE ${conditions.join(' AND ')} ORDER BY m.rowid DESC LIMIT ?`).all(q, ...values, size + 1);
    const items = rows.slice(0, size);
    return { items, hasMore: rows.length > size, nextCursor: items.at(-1)?.cursor || null };
  },
};
parentPort.on('message', ({ requestId, op, params }) => {
  try {
    if (!Object.hasOwn(operations, op)) throw new Error('未知查询');
    parentPort.postMessage({ requestId, result: operations[op](params || {}) });
  } catch (e) { parentPort.postMessage({ requestId, error: e.message }); }
});
