/** Extract readable text without discarding the original message payload. */
export function extractContent(content) {
  const assets = [];
  function visit(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(visit).filter(Boolean).join('\n\n');
    if (typeof value !== 'object') return String(value);
    if (['code', 'execution_output'].includes(value.type) && typeof value.text === 'string') {
      const longest = Math.max(2, ...(value.text.match(/`+/g) || []).map(s => s.length));
      const fence = '`'.repeat(longest + 1);
      return `${fence}${value.language || ''}\n${value.text}\n${fence}`;
    }
    if (value.type === 'image' || value.content_type === 'image_asset_pointer' || value.image_asset_pointer) {
      const image = value.image_asset_pointer || value.content?.image_asset_pointer || value.content || value;
      assets.push({ kind: 'image', ...image });
      return '';
    }
    if (value.type === 'structured_thoughts') {
      return (value.thoughts || []).map(t => [t.summary && `### ${t.summary}`, visit(t.content), visit(t.chunks)].filter(Boolean).join('\n\n')).join('\n\n');
    }
    for (const key of ['parts', 'content', 'text', 'instructions', 'thoughts']) {
      if (value[key] != null) return visit(value[key]);
    }
    // Unknown content must remain visible instead of silently disappearing.
    if (Object.keys(value).every(k => ['type', 'transcription_unavailable'].includes(k))) return '';
    return JSON.stringify(value, null, 2);
  }
  return { text: visit(content), assets };
}

export function normalizeMessage(raw, id, conversationId, chunkCount, byteLength) {
  const { text, assets } = extractContent(raw.content);
  const known = new Set(assets.map(a => a.asset_pointer));
  for (const a of [...(raw.attachments || []), ...(raw.non_image_attachments || [])]) {
    if (!known.has(a.asset_pointer)) { assets.push({ kind: a.mime_type?.startsWith('image/') ? 'image' : 'file', ...a }); known.add(a.asset_pointer); }
  }
  const role = String(raw.role || raw.author?.role || 'Unknown');
  const channel = String(raw.channel || '');
  const isDetail = !!raw.is_visually_hidden_in_conversation || !['user', 'assistant'].includes(role.toLowerCase()) ||
    ['analysis', 'commentary', 'justify', 'confidence'].includes(channel) || ['structured_thoughts', 'reasoning_recap'].includes(raw.content?.type);
  return {
    id, conversationId, parentId: raw.parent_id || null, role, channel,
    model: raw.model_slug || raw.model || '', contentType: raw.content?.type || 'unknown',
    createdAt: raw.created_date || raw.create_time || null,
    modifiedAt: raw.modification_date || null, hidden: !!raw.is_visually_hidden_in_conversation,
    detail: isDetail, text, assets, chunkCount, byteLength,
  };
}

/** Parent first, deterministic chronological order between available nodes. Retains every branch. */
export function orderMessages(messages) {
  const byId = new Map(messages.map(m => [m.id, m]));
  const children = new Map();
  const ready = [];
  const compare = (a, b) => {
    const ta = typeof a.createdAt === 'number' ? a.createdAt * 1000 : Date.parse(a.createdAt) || 0;
    const tb = typeof b.createdAt === 'number' ? b.createdAt * 1000 : Date.parse(b.createdAt) || 0;
    return ta - tb || a.id.localeCompare(b.id);
  };
  for (const m of messages) {
    if (m.parentId && byId.has(m.parentId) && m.parentId !== m.id) {
      if (!children.has(m.parentId)) children.set(m.parentId, []);
      children.get(m.parentId).push(m);
    } else ready.push(m);
  }
  ready.sort(compare);
  const result = [], seen = new Set();
  while (ready.length) {
    const m = ready.shift();
    if (seen.has(m.id)) continue;
    seen.add(m.id); result.push(m);
    ready.push(...(children.get(m.id) || [])); ready.sort(compare);
  }
  // Corrupt/cyclic parent links must never remove a message from the archive.
  result.push(...messages.filter(m => !seen.has(m.id)).sort(compare));
  return result.map((m, seq) => ({ ...m, seq, siblings: (children.get(m.parentId) || []).length }));
}
