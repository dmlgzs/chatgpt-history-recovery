import { readFileSync, readdirSync, openSync, readSync, closeSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, basename } from 'node:path';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';

export function *walkFiles(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walkFiles(path);
    else if (entry.isFile()) yield path;
  }
}
/** Decode copied cache streams; never opens an original browser profile. */
export function *decodeCacheFile(file) {
  const data = readFileSync(file);
  yield* decodeCacheBuffer(data);
}
export function *decodeCacheBuffer(data) {
  yield { data, encoding: 'identity' };
  const candidates = [data];
  // Chromium Simple Cache file header, followed by the URL cache key.
  if (data.length > 48 && data.readBigUInt64LE(0) === 0xfcfb6d1ba7725c30n) {
    const keyLength = data.readUInt32LE(12);
    const footer = data.length - 24;
    if (keyLength < 65536 && data.readBigUInt64LE(footer) === 0xf4fa6f45970d41d8n) {
      const headerSize = data.readUInt32LE(footer + 16), flags = data.readUInt32LE(footer + 8);
      const end = footer - headerSize - (flags & 2 ? 32 : 0) - 24;
      if (end > 24 + keyLength) { const body = data.subarray(24 + keyLength, end); candidates.push(body); yield { data: body, encoding: 'identity' }; }
    }
  }
  for (const candidate of candidates) {
    for (const [encoding, fn] of [['gzip', gunzipSync], ['deflate', inflateSync], ['br', brotliDecompressSync]]) {
      try { yield { data: fn(candidate, { maxOutputLength: 128 * 1024 * 1024 }), encoding }; } catch {}
    }
  }
}

export function readCacheConversations(snapshot) {
  const found = new Map();
  const cacheDirs = new Set();
  function accept(data, file, encoding, extra = {}) {
      const first = data[0]; if (first !== 123 && first !== 91) return;
      let payload; try { payload = JSON.parse(data.toString('utf8')); } catch { return; }
      const id = payload.conversation_id || payload.id;
      let messages = payload.messages;
      if (!messages && payload.mapping) messages = Object.values(payload.mapping).filter(n => n.message).map(n => ({ ...n.message, parent_id: n.parent }));
      if (!id || !Array.isArray(messages) || !messages.some(m => m?.id && m?.content)) return;
      if (!found.has(id)) found.set(id, { id, title: payload.title, messages: new Map(), pages: [] });
      const conversation = found.get(id);
      if (!conversation.pages.some(p => p.file === file)) conversation.pages.push({ file, encoding, ...extra, payload });
      for (const m of messages) {
        if (!m?.id || !m.content) continue;
        const existing = conversation.messages.get(m.id);
        if (!existing || JSON.stringify(m).length > JSON.stringify(existing).length) conversation.messages.set(m.id, m);
      }
  }
  for (const file of walkFiles(snapshot)) {
    if (basename(file) === 'data_1') cacheDirs.add(dirname(file));
    // Disk cache external streams; support already-extracted JSON exports as well.
    if (!/(?:[\\/](?:f_[0-9a-f]+|[0-9a-f]{16}_[01])|\.conversation\.json)$/i.test(file)) continue;
    for (const { data, encoding } of decodeCacheFile(file)) {
      accept(data, relative(snapshot, file), encoding);
    }
  }
  for (const dir of cacheDirs) {
    for (const entry of legacyCacheEntries(dir)) {
      for (const { data, encoding } of decodeCacheBuffer(entry.data)) accept(data, `${relative(snapshot, entry.file)}#${entry.offset}`, encoding, { cacheState: entry.state });
    }
  }
  return found;
}

/** Legacy Chromium block-file cache. Walk intact EntryStore records, including remnants. */
export function *legacyCacheEntries(dir) {
  const handles = new Map();
  const read = (file, offset, size) => {
    if (size < 0 || size > 128 * 1024 * 1024 || offset < 0) throw new Error('Invalid cache stream');
    if (!handles.has(file)) handles.set(file, openSync(file, 'r'));
    const out = Buffer.alloc(size), n = readSync(handles.get(file), out, 0, size, offset);
    if (n !== size) throw new Error('Truncated cache stream');
    return out;
  };
  const address = (value, size) => {
    if (!(value >>> 31)) throw new Error('Uninitialized cache address');
    const type = (value >>> 28) & 7;
    if (!type) return read(join(dir, `f_${(value & 0x0fffffff).toString(16).padStart(6, '0')}`), 0, size);
    const blockSize = { 1: 36, 2: 256, 3: 1024, 4: 4096, 5: 8, 6: 104, 7: 48 }[type];
    if (size > blockSize * (((value >>> 24) & 3) + 1)) throw new Error('Cache address size mismatch');
    return read(join(dir, `data_${(value >>> 16) & 255}`), 8192 + (value & 65535) * blockSize, size);
  };
  try {
    for (const name of readdirSync(dir).filter(n => /^data_\d+$/.test(n))) {
      const file = join(dir, name), header = read(file, 0, 20);
      if (header.readUInt32LE(0) !== 0xc104cac3 || header.readUInt32LE(12) !== 256) continue;
      const records = readFileSync(file);
      for (let offset = 8192; offset + 256 <= records.length; offset += 256) {
        const r = records.subarray(offset), keyLength = r.readInt32LE(32), state = r.readInt32LE(20);
        if (keyLength <= 0 || keyLength > 65536 || state < 0 || state > 2 || !r.readUInt32LE(0)) continue;
        try {
          const key = r.readUInt32LE(36) ? address(r.readUInt32LE(36), keyLength).toString() : r.subarray(96, 96 + keyLength).toString();
          if (!/https:\/\/(?:chatgpt\.com|chat\.openai\.com)\/backend-api\//.test(key)) continue;
          const size = r.readInt32LE(44), addr = r.readUInt32LE(60);
          if (size > 0 && addr) yield { file, offset, state, data: address(addr, size) };
        } catch { /* Invalid/overwritten remnants cannot be recovered as intact streams. */ }
      }
    }
  } finally { for (const fd of handles.values()) closeSync(fd); }
}

export function adaptCachedMessage(raw, conversationId) {
  const role = raw.author?.role || raw.role || 'unknown';
  const content = raw.content || {};
  const type = content.content_type || content.type;
  return {
    ...raw, conversation_id: conversationId,
    role: role[0].toUpperCase() + role.slice(1),
    model: raw.metadata?.model_slug || raw.model || '',
    created_date: raw.create_time ? new Date(raw.create_time * 1000).toISOString() : null,
    is_visually_hidden_in_conversation: !!raw.metadata?.is_visually_hidden_from_conversation,
    content: type === 'thoughts' ? { ...content, type: 'structured_thoughts' } : { ...content, type },
    attachments: raw.metadata?.attachments || raw.attachments || [],
  };
}
