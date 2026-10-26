/* Local-only archive reader. No telemetry, CDN, or remote media requests. */
const $ = selector => document.querySelector(selector);
const icons = {
  search: '<circle cx="10.8" cy="10.8" r="6.7"/><path d="m16 16 4.5 4.5"/>',
  grid: '<rect x="3.5" y="3.5" width="6" height="6" rx="1.4"/><rect x="14.5" y="3.5" width="6" height="6" rx="1.4"/><rect x="3.5" y="14.5" width="6" height="6" rx="1.4"/><rect x="14.5" y="14.5" width="6" height="6" rx="1.4"/>',
  'arrow-up-right': '<path d="M7 17 17 7M7 7h10v10"/>',
  arrow: '<path d="M4 12h16m-5-5 5 5-5 5"/>',
  back: '<path d="M20 12H4m5-5-5 5 5 5"/>',
  moon: '<path d="M20 14.6A8.5 8.5 0 0 1 9.4 4 8.5 8.5 0 1 0 20 14.6Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.2"/>',
  chat: '<path d="M20 11.5a7.8 7.8 0 0 1-8.2 7.5H5l-3 3 .9-6A7.2 7.2 0 0 1 4 6a8.6 8.6 0 0 1 16 5.5Z"/>',
  stack: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  file: '<path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10l-7-7Zm0 0v7h7M8 14h8m-8 3h5"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m4 17 5-5 4 4 3-3 5 5"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/>',
  code: '<path d="m7 7-5 5 5 5m10-10 5 5-5 5m-4-14-2 18"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.file}</svg>`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fillIcons(root = document) { root.querySelectorAll('[data-icon]').forEach(n => { n.innerHTML = icon(n.dataset.icon); }); }
const number = n => Number(n || 0).toLocaleString('zh-CN');
const date = (value, full = false) => value ? new Date(value).toLocaleString('zh-CN', full ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false } : { year: 'numeric', month: '2-digit', day: '2-digit' }) : '时间未知';
const time = value => value ? new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
const readSetting = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const saveSetting = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
const state = { stats: null, active: null, filter: 'all', sort: 'recent', listOffset: 0, listMore: false, listBusy: false,
  listGeneration: 0, generation: 0, pageGeneration: 0, list: [], messages: new Map(), page: null,
  details: readSetting('archive-details', '0') === '1', searchGeneration: 0, searchMore: false, searchCursor: null, fullMessage: null };
let listController, navigationController, searchController, toastTimer;
async function api(path, params, signal) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params || {})) if (v != null) url.searchParams.set(k, v);
  const response = await fetch(url, { signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '读取失败');
  return result;
}
function toast(text) { const el = $('#toast'); el.textContent = text; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3000); }
function errorView(error) { if (error.name !== 'AbortError') $('#workspace').innerHTML = `<div class="error-state">${escape(error.message)}<br><button class="text-button" data-action="reload">重新读取</button></div>`; }
const loading = '<div class="loading"><span class="spinner"></span>正在打开对话…</div>';
function route(id, messageId) {
  const p = new URLSearchParams(); if (id) p.set('conversation', id); if (messageId) p.set('message', messageId);
  const hash = p.size ? `#${p}` : '#';
  if (location.hash === hash || (!location.hash && hash === '#')) loadRoute(); else location.hash = hash;
}
function closeSidebar() { $('#sidebar').classList.remove('open'); $('#sidebar-overlay').hidden = true; }
async function loadList(reset = false) {
  if (!reset && (state.listBusy || !state.listMore)) return;
  if (reset) { listController?.abort(); listController = new AbortController(); state.listGeneration++; state.listOffset = 0; state.list = []; }
  const version = state.listGeneration, offset = state.listOffset;
  state.listBusy = true;
  const container = $('#conversation-list');
  if (reset) container.innerHTML = '<p class="list-status">正在读取…</p>';
  try {
    const result = await api('/api/conversations', { q: $('#title-filter').value.trim(), filter: state.filter, sort: state.sort, offset, limit: 60 }, listController?.signal);
    if (version !== state.listGeneration) return;
    state.list.push(...result.items); state.listOffset += result.items.length; state.listMore = result.hasMore;
    if (reset) container.replaceChildren();
    container.querySelector('.list-more')?.remove();
    const fragment = document.createDocumentFragment();
    for (const c of result.items) {
      const button = document.createElement('button'); button.className = 'conversation-item'; button.dataset.conversation = c.id;
      if (c.id === state.active?.id) { button.classList.add('selected'); button.setAttribute('aria-current', 'true'); }
      button.title = c.title;
      button.innerHTML = `<span class="title">${escape(c.title)}</span><span class="meta"><span>${date(c.updatedAt)}</span><span>${c.messageCount ? `${number(c.messageCount)} 条消息` : '仅标题'}</span></span>`;
      fragment.append(button);
    }
    container.append(fragment);
    $('#sidebar-count').textContent = number(result.total);
    if (!state.list.length) container.innerHTML = '<p class="list-status">没有符合条件的会话</p>';
    if (result.hasMore) container.insertAdjacentHTML('beforeend', '<button class="text-button list-more" data-action="more-conversations">加载更多会话</button>');
  } catch (e) {
    if (e.name !== 'AbortError' && version === state.listGeneration) {
      if (reset) container.replaceChildren();
      container.insertAdjacentHTML('beforeend', `<p class="list-status">${escape(e.message)}<br><button class="text-button" data-action="retry-list">重新加载</button></p>`);
    }
  } finally { if (version === state.listGeneration) state.listBusy = false; }
}
function updateSelection() {
  document.querySelectorAll('.conversation-item').forEach(el => {
    const selected = el.dataset.conversation === state.active?.id; el.classList.toggle('selected', selected);
    if (selected) el.setAttribute('aria-current', 'true'); else el.removeAttribute('aria-current');
  });
  $('#home-button').classList.toggle('active', !state.active);
}
function recentCard(c) {
  return `<button class="recent-card" data-conversation="${escape(c.id)}"><div class="recent-card-top"><span class="mini-icon">${icon('chat')}</span><span>${date(c.updatedAt)}</span></div><h3>${escape(c.title)}</h3><p>${escape(c.preview || '此对话没有可预览的文本内容')}</p><div class="recent-card-bottom"><span>${number(c.messageCount)} 条消息 · ${number(c.visibleCount)} 条对话正文</span>${icon('arrow-up-right')}</div></button>`;
}
async function showHome(signal, generation) {
  const recent = await api('/api/conversations', { filter: 'cached', limit: 6 }, signal);
  if (state.generation !== generation) return;
  const s = state.stats, c = s.counts;
  $('#breadcrumb-page').textContent = '概览'; document.title = '拾光 · 聊天档案';
  $('#workspace').innerHTML = `<section class="overview"><div class="hero"><div><div class="eyebrow">YOUR CONVERSATIONS, PRESERVED</div><h1>每一次对话，<br>都<em>有迹可循。</em></h1><p>让灵感、思考与那些值得留下的瞬间，在这里重新相遇。<br>你的 ChatGPT 聊天记录，已整理成一份属于自己的档案。</p></div><div class="hero-art" aria-hidden="true"><div class="art-orbit"></div><div class="art-card"></div><div class="art-card front"><i></i><i></i><i></i></div></div></div>
    <div class="stats-grid"><div class="stat-card">${icon('stack')}<div class="stat-label">归档会话</div><div class="stat-number">${number(c.conversations)}<small>个</small></div><div class="stat-caption">每一个话题，都有自己的位置</div></div><div class="stat-card">${icon('chat')}<div class="stat-label">已恢复消息</div><div class="stat-number">${number(c.messages)}<small>条</small></div><div class="stat-caption">包含正文、思考与工具记录</div></div><div class="stat-card">${icon('file')}<div class="stat-label">有正文的会话</div><div class="stat-number">${number(c.conversations - c.emptyConversations)}<small>个</small></div><div class="stat-caption">另有 ${number(c.emptyConversations)} 个会话仅缓存标题</div></div></div>
    <div class="section-title"><h2>继续翻阅</h2><button class="text-button" data-action="search">在档案中寻找 ${icon('arrow')}</button></div><div class="recent-grid">${recent.items.map(recentCard).join('') || '<p class="muted">尚无缓存正文。</p>'}</div>
    <div class="archive-note">${icon('info')}<div>这是一份设备上的本地记录。只缓存标题的会话、未下载的图片和附件，无法凭数据库补回正文或文件。所有已存在的消息与原始数据均已保留。<button class="text-button" data-action="report">查看恢复报告 ${icon('arrow-up-right')}</button></div></div>
    <footer class="overview-footer"><span>拾光 / A PLACE FOR YOUR THOUGHTS</span><span>归档于 ${date(s.recoveredAt)} · ${Math.round(s.source.bytes / 1024 / 1024)} MB 源数据库</span></footer></section>`;
}
async function loadRoute() {
  const generation = ++state.generation; state.pageGeneration++;
  navigationController?.abort(); navigationController = new AbortController(); const signal = navigationController.signal;
  state.messages.clear(); state.fullMessage = null; state.page = null; closeSidebar();
  const p = new URLSearchParams(location.hash.slice(1)), id = p.get('conversation'), target = p.get('message');
  $('#workspace').innerHTML = loading; $('#workspace').scrollTop = 0;
  try {
    if (!id) { state.active = null; updateSelection(); await showHome(signal, generation); return; }
    const conv = await api(`/api/conversations/${encodeURIComponent(id)}`, {}, signal);
    if (state.generation !== generation) return;
    state.active = conv; updateSelection();
    $('#breadcrumb-page').textContent = conv.title; document.title = `${conv.title} · 拾光`;
    if (target) state.details = true;
    $('#workspace').innerHTML = `<article class="reader"><header class="reader-heading"><div class="eyebrow">CONVERSATION ARCHIVE</div><h1>${escape(conv.title)}</h1><div class="reader-meta"><span>${date(conv.createdAt, true)}</span><span>${number(conv.messageCount)} 条消息</span><span>${number(conv.visibleCount)} 条对话正文</span></div></header><div class="reader-toolbar"><label><input type="checkbox" id="include-details" ${state.details ? 'checked' : ''}>显示工具、思考与隐藏消息</label><div class="toolbar-buttons"><button class="small-button" data-action="search-current">${icon('search')}搜索</button><a class="small-button" href="/api/export/${encodeURIComponent(id)}/md" download>${icon('download')}Markdown</a><a class="small-button" href="/api/export/${encodeURIComponent(id)}/json" download>JSON</a></div></div><div id="messages" class="message-list">${loading}</div><div id="message-pager"></div><div class="source-note">原始消息及父消息关联均已保留。多个分支按父子关系与时间排列，未推断客户端选中的分支。<br>会话 ID：${escape(id)}</div></article>`;
    if (conv.recovery?.supplementalMessages) {
      const coverage = conv.recovery.cacheCoverage === 'unknown' ? '缓存未提供分页信息，完整性未知。' : conv.recovery.cachedPagePartial ? '该缓存注明分页不完整，可能缺少较早或较晚的消息。' : '缓存响应未标记前后有更多分页。';
      $('.reader-toolbar').insertAdjacentHTML('afterend', `<div class="archive-note">${icon('info')}<div>${conv.recovery.cacheOnly ? '这是手机数据库之外、从浏览器缓存单独恢复的会话。' : ''}从浏览器缓存副本补回 ${number(conv.recovery.supplementalMessages)} 条消息。${coverage}原始缓存响应与来源已单独保留。</div></div>`);
    }
    await loadPage({ around: target }, signal);
  } catch (e) { if (state.generation === generation) errorView(e); }
}
function renderMarkdown(text) {
  const renderer = new marked.Renderer();
  renderer.image = ({ text, href }) => `<span class="muted">[图片：${escape(text || href || '外部引用')} · 未载入外部资源]</span>`;
  const html = marked.parse(text, { gfm: true, breaks: false, renderer });
  return DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'img', 'video', 'audio', 'iframe', 'form', 'input', 'button', 'svg', 'math'], FORBID_ATTR: ['style', 'id', 'name'], ALLOW_DATA_ATTR: false });
}
function enhanceMarkdown(root) {
  root.querySelectorAll('.message-body a').forEach(a => {
    if (!/^(https?:|mailto:)/i.test(a.getAttribute('href') || '')) { a.removeAttribute('href'); return; }
    a.target = '_blank'; a.rel = 'noopener noreferrer nofollow';
  });
  root.querySelectorAll('.message-body pre').forEach(pre => {
    const bar = document.createElement('div'); bar.className = 'code-toolbar';
    const language = pre.querySelector('code')?.className.replace(/^language-/, '') || '代码';
    bar.innerHTML = `<span>${escape(language)}</span><button data-action="copy-code">${icon('copy')}复制</button>`;
    pre.before(bar);
  });
}
function assetHTML(a) {
  return `<div class="asset-card">${icon(a.kind === 'image' ? 'image' : 'file')}<div class="asset-name">${escape(a.name || (a.kind === 'image' ? '图片引用' : '附件引用'))}<small>${a.width && a.height ? `${a.width} × ${a.height} · ` : ''}${a.size || a.size_bytes ? `${number(a.size || a.size_bytes)} 字节 · ` : ''}数据库仅保存引用，未提供本地文件</small><div class="asset-pointer">${escape(a.asset_pointer || a.content_type || '')}</div></div></div>`;
}
function bodyHTML(m) {
  return `${m.text ? renderMarkdown(m.text) : '<p class="muted">（此消息没有文本内容）</p>'}${m.assets.map(assetHTML).join('')}${m.truncated ? `<button class="load-full" data-action="expand" data-id="${escape(m.id)}">展开完整消息 · ${number(m.textLength)} 字符 ${icon('arrow')}</button>` : ''}`;
}
function messageHTML(m) {
  const id = escape(m.id), role = m.role.toLowerCase(), user = role === 'user';
  const actions = `<div class="message-actions"><button data-action="copy-message" data-id="${id}">${icon('copy')}复制</button><button data-action="raw" data-id="${id}">${icon('code')}原始数据</button><span title="${escape(m.id)}">#${m.seq + 1}</span>${m.siblings > 1 ? '<span class="branch" title="与其他消息共享父节点；不代表当前客户端选中分支">关联分支</span>' : ''}</div>`;
  if (m.detail) return `<details class="message message-detail" data-message="${id}"><summary><span>${escape(m.role)}</span>${m.channel ? `<span class="model-tag">${escape(m.channel)}</span>` : ''}<span class="detail-preview">${escape(m.text.slice(0, 100) || m.contentType)}</span><span>#${m.seq + 1}</span></summary><div class="detail-content" data-lazy="${id}"></div>${actions}</details>`;
  return `<section class="message message-${user ? 'user' : 'assistant'}" data-message="${id}"><div class="message-author"><span class="avatar">${user ? '我' : '✳'}</span><strong>${user ? '你' : 'ChatGPT'}</strong>${!user && m.model ? `<span class="model-tag">${escape(m.model)}</span>` : ''}<time title="${escape(date(m.createdAt, true))}">${time(m.createdAt)}</time></div><div class="message-body">${bodyHTML(m)}</div>${actions}</section>`;
}
async function loadPage(options = {}, signal = navigationController?.signal) {
  if (!state.active) return;
  const generation = state.generation, pageGeneration = ++state.pageGeneration, convId = state.active.id;
  const container = $('#messages');
  if (!container) return;
  container.setAttribute('aria-busy', 'true');
  $('#message-pager')?.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try {
    const result = await api(`/api/conversations/${encodeURIComponent(convId)}/messages`, { details: state.details ? '1' : '0', ...options }, signal);
    if (generation !== state.generation || pageGeneration !== state.pageGeneration) return;
    state.page = result; state.messages = new Map(result.items.map(m => [m.id, m])); state.fullMessage = null;
    if (!result.items.length) {
      const empty = state.active.messageCount === 0;
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">${icon(empty ? 'file' : 'stack')}</div><h2>${empty ? '标题还在，正文未缓存' : '这段对话包含详细消息'}</h2><p>${empty ? '这台设备只保存了此会话的标题与元数据。数据库中没有对应的消息内容，因此无法恢复正文。你仍可以导出已保存的会话信息。' : '打开上方「显示工具、思考与隐藏消息」，即可查看已恢复的全部消息。'}</p></div>`;
      $('#message-pager').replaceChildren();
    } else {
      container.innerHTML = result.items.map(messageHTML).join(''); enhanceMarkdown(container);
      const first = result.items[0], last = result.items.at(-1);
      $('#message-pager').innerHTML = `<nav class="pager" aria-label="消息分页"><button class="small-button" data-action="previous" ${!result.hasBefore ? 'disabled' : ''}>${icon('back')}上一段</button><span>消息 #${first.seq + 1}–${last.seq + 1} / ${number(state.active.messageCount)}<br>本段 ${result.items.length} 条 · 按需读取</span><button class="small-button" data-action="next" ${!result.hasAfter ? 'disabled' : ''}>下一段${icon('arrow')}</button></nav>`;
    }
    container.removeAttribute('aria-busy');
    if (options.around) {
      const target = [...container.querySelectorAll('[data-message]')].find(e => e.dataset.message === options.around);
      if (target) { target.classList.add('target'); if (target.tagName === 'DETAILS') target.open = true; requestAnimationFrame(() => { if (target.isConnected) target.scrollIntoView({ block: 'start' }); }); }
    } else $('#workspace').scrollTop = 0;
  } catch (e) {
    if (e.name !== 'AbortError' && generation === state.generation && pageGeneration === state.pageGeneration) {
      container.innerHTML = `<div class="error-state">${escape(e.message)}<br><button data-action="reload" class="text-button">重新读取会话</button></div>`;
      $('#message-pager')?.replaceChildren(); container.removeAttribute('aria-busy');
    }
  }
}
document.addEventListener('toggle', event => {
  const el = event.target;
  if (!el.matches?.('.message-detail[open]')) return;
  const lazy = el.querySelector('[data-lazy]');
  if (lazy) {
    const m = state.messages.get(lazy.dataset.lazy); if (!m) return;
    lazy.innerHTML = `<div class="message-body">${bodyHTML(m)}</div>`; delete lazy.dataset.lazy; enhanceMarkdown(lazy);
  }
}, true);
async function getFull(id) {
  if (state.fullMessage?.id === id) return state.fullMessage;
  const full = await api(`/api/messages/${encodeURIComponent(id)}`);
  // Only one full payload is retained. Page messages stay bounded at 24 entries.
  if (state.messages.has(id)) state.fullMessage = full;
  return full;
}
async function expandMessage(id, button) {
  button.disabled = true; button.textContent = '正在读取…'; const generation = state.generation;
  try {
    const full = await getFull(id); if (state.generation !== generation || !button.isConnected) return;
    const body = button.closest('.message-body');
    if (full.text.length > 60000) {
      const size = 30000, pages = Math.ceil(full.text.length / size); let page = 0;
      const render = () => {
        body.innerHTML = '<p class="muted">超长消息按每段 30,000 字符分页，以纯文本显示。复制与导出始终包含完整内容。</p><div class="message-plain"></div><div class="message-segment-controls"><button class="segment-prev">上一段</button><span></span><button class="segment-next">下一段</button></div>';
        body.querySelector('.message-plain').textContent = full.text.slice(page * size, (page + 1) * size);
        body.querySelector('.message-segment-controls span').textContent = `${page + 1} / ${pages}`;
        const prev = body.querySelector('.segment-prev'), next = body.querySelector('.segment-next'); prev.disabled = page === 0; next.disabled = page === pages - 1;
        prev.onclick = () => { page--; render(); body.scrollIntoView({ block: 'start' }); };
        next.onclick = () => { page++; render(); body.scrollIntoView({ block: 'start' }); };
      }; render();
    } else { body.innerHTML = bodyHTML(full); enhanceMarkdown(body); }
  } catch (e) { toast(e.message); if (button.isConnected) { button.disabled = false; button.textContent = '重试读取完整消息'; } }
}
function highlighted(text, q) {
  if (!q) return escape(text);
  const lower = text.toLocaleLowerCase(), needle = q.toLocaleLowerCase(); let pos = 0, found, html = '';
  while ((found = lower.indexOf(needle, pos)) !== -1) { html += escape(text.slice(pos, found)) + `<mark>${escape(text.slice(found, found + q.length))}</mark>`; pos = found + q.length; }
  return html + escape(text.slice(pos));
}
function openSearch(current = false) {
  $('#search-current').checked = current && !!state.active;
  $('#search-current').disabled = !state.active;
  if (!$('#search-dialog').open) $('#search-dialog').showModal();
  $('#global-search').focus(); $('#global-search').select(); runSearch();
}
function closeSearch() { $('#search-dialog').close(); searchController?.abort(); state.searchGeneration++; }
let searchTimer;
async function runSearch(more = false) {
  const q = $('#global-search').value.trim();
  if (!more) { searchController?.abort(); searchController = new AbortController(); state.searchGeneration++; state.searchCursor = null; state.searchMore = false; }
  const generation = state.searchGeneration, signal = searchController.signal, container = $('#search-results');
  if (!q) { container.replaceChildren(); $('#search-status').textContent = '输入关键词，搜索正文与会话标题'; return; }
  $('#search-status').textContent = '正在搜索…';
  if (!more) container.innerHTML = '<p class="list-status"><span class="spinner"></span>在档案中寻找…</p>';
  try {
    const current = $('#search-current').checked ? state.active?.id : null;
    const [result, titles] = await Promise.all([api('/api/search', { q, cursor: more ? state.searchCursor : null, conversationId: current }, signal), !more && !current ? api('/api/conversations', { q, limit: 5 }, signal) : Promise.resolve({ items: [] })]);
    if (generation !== state.searchGeneration) return;
    state.searchMore = result.hasMore; state.searchCursor = result.nextCursor;
    if (!more) container.replaceChildren();
    container.querySelector('.search-more')?.remove();
    if (titles.items.length) container.insertAdjacentHTML('beforeend', `<div class="search-label">匹配的会话标题</div>${titles.items.map(c => `<button class="search-result" data-conversation="${escape(c.id)}"><strong>${highlighted(c.title, q)}</strong><small>${number(c.messageCount)} 条消息${c.messageCount ? '' : ' · 仅标题'}</small></button>`).join('')}<div class="search-label">消息正文</div>`);
    container.insertAdjacentHTML('beforeend', result.items.map(m => `<button class="search-result" data-conversation="${escape(m.conversationId)}" data-target-message="${escape(m.id)}"><strong>${escape(m.title)}</strong><small>${escape(m.role)}${m.channel ? ` · ${escape(m.channel)}` : ''} · 消息 #${m.seq + 1}</small><p>${highlighted(m.snippet, q)}</p></button>`).join(''));
    if (!more && !result.items.length && !titles.items.length) container.innerHTML = '<p class="list-status">没有找到匹配内容。试试更短的关键词。</p>';
    if (result.hasMore) container.insertAdjacentHTML('beforeend', '<button class="small-button search-more" data-action="search-more">加载更多结果</button>');
    $('#search-status').textContent = result.hasMore ? '已显示一部分结果，可继续加载' : '搜索完成 · 点击消息即可定位';
  } catch (e) {
    if (e.name !== 'AbortError' && generation === state.searchGeneration) {
      $('#search-status').textContent = e.message;
      container.innerHTML = '<p class="list-status">搜索失败，请调整关键词后重试。</p>';
    }
  }
}
function showDetail(title, html) { $('#detail-title').textContent = title; $('#detail-body').innerHTML = html; if (!$('#detail-dialog').open) $('#detail-dialog').showModal(); }
function showReport() {
  if (!state.stats) return;
  const s = state.stats, c = s.counts;
  showDetail('恢复报告', `<p>${escape(s.source.name)}</p><div class="report-grid">${[
    ['会话', number(c.conversations)], ['手机原库消息', `${number(c.parsedMessages)} / ${number(c.sourceMessages + c.orphanChunkMessages)}`], ['消息数据块', `${number(c.chunks)} / ${number(c.sourceChunks)}`], ['解析失败', number(c.failedMessages)], ['缓存补回的消息', number(c.supplementalMessages)], ['补回正文的空会话', number(c.restoredEmptyConversations)], ['仅标题的会话', number(c.emptyConversations)], ['工具、思考等详细消息', number(c.detailMessages)], ['附件引用（非文件）', number(c.assets)], ['完整性检查', s.integrity.join(', ')],
  ].map(([label, value]) => `<div class="report-item"><span>${label}</span><strong>${escape(value)}</strong></div>`).join('')}</div><p>恢复耗时：${number(s.durationMs)} ms<br>归档时间：${date(s.recoveredAt, true)}<br>异常记录：${s.issues.length} 条</p><p class="asset-pointer">源文件 SHA-256：${escape(s.source.sha256)}</p><ul>${s.notes.map(n => `<li>${escape(n)}</li>`).join('')}</ul><a href="/api/report" target="_blank" rel="noopener" class="small-button">${icon('code')}查看完整 JSON 报告</a>`);
}
async function showRaw(id) {
  const generation = state.generation;
  const m = await getFull(id); if (generation !== state.generation) return;
  const text = JSON.stringify(m.raw, null, 2);
  showDetail('原始消息数据', `<p class="asset-pointer">${escape(id)}</p><button class="small-button" id="download-raw">${icon('download')}下载完整 JSON</button><p class="muted">${text.length > 40000 ? '数据较长，下面仅预览前 40,000 字符。下载包含完整内容。' : '保留数据库中的原始字段与结构。'}</p><pre id="raw-preview"></pre>`);
  $('#raw-preview').textContent = text.slice(0, 40000);
  $('#download-raw').onclick = () => downloadText(text, `message-${id.replace(/[^a-zA-Z0-9-]/g, '_')}.json`);
}
function downloadText(text, name) { const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); }
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('已复制完整内容'); } catch { toast('浏览器未允许剪贴板访问，可使用导出功能'); } }
document.addEventListener('click', async event => {
  const conv = event.target.closest('[data-conversation]');
  if (conv) { if ($('#search-dialog').open) closeSearch(); route(conv.dataset.conversation, conv.dataset.targetMessage); return; }
  const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
  try {
    switch (button.dataset.action) {
      case 'reload': await loadRoute(); break;
      case 'retry-list': await loadList(true); break;
      case 'more-conversations': await loadList(); break;
      case 'search': openSearch(); break;
      case 'search-current': openSearch(true); break;
      case 'search-more': button.disabled = true; await runSearch(true); break;
      case 'report': showReport(); break;
      case 'previous': await loadPage({ before: state.page.items[0].seq }); break;
      case 'next': await loadPage({ after: state.page.items.at(-1).seq }); break;
      case 'expand': await expandMessage(button.dataset.id, button); break;
      case 'copy-message': { const m = await getFull(button.dataset.id); await copy(m.text); break; }
      case 'copy-code': await copy(button.closest('.code-toolbar').nextElementSibling.querySelector('code')?.textContent || ''); break;
      case 'raw': await showRaw(button.dataset.id); break;
    }
  } catch (e) { if (e.name !== 'AbortError') toast(e.message); }
});
document.addEventListener('change', event => {
  if (event.target.id === 'include-details') { state.details = event.target.checked; saveSetting('archive-details', state.details ? '1' : '0'); loadPage(); }
});
$('#open-search').onclick = () => openSearch(); $('#close-search').onclick = closeSearch;
$('#search-dialog').addEventListener('cancel', event => { event.preventDefault(); closeSearch(); });
$('#search-dialog').addEventListener('click', event => { if (event.target === $('#search-dialog')) closeSearch(); });
$('#close-detail').onclick = () => { $('#detail-dialog').close(); $('#detail-body').replaceChildren(); };
$('#detail-dialog').addEventListener('close', () => { $('#detail-body').replaceChildren(); });
$('#global-search').oninput = () => { clearTimeout(searchTimer); searchController?.abort(); state.searchGeneration++; searchTimer = setTimeout(() => runSearch(), 220); };
$('#search-current').onchange = () => { clearTimeout(searchTimer); runSearch(); };
let titleTimer;
$('#title-filter').oninput = () => { clearTimeout(titleTimer); listController?.abort(); state.listGeneration++; titleTimer = setTimeout(() => loadList(true), 160); };
$('#sort').onchange = event => { state.sort = event.target.value; loadList(true); };
document.querySelectorAll('[data-filter]').forEach(button => { button.onclick = () => {
  state.filter = button.dataset.filter; document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b === button)); loadList(true);
}; });
$('#home-button').onclick = () => route(); $('#show-report').onclick = showReport;
$('#mobile-menu').onclick = () => { $('#sidebar').classList.add('open'); $('#sidebar-overlay').hidden = false; };
$('#sidebar-overlay').onclick = closeSidebar;
$('#conversation-list').addEventListener('scroll', () => { const el = $('#conversation-list'); if (el.scrollTop + el.clientHeight > el.scrollHeight - 220) loadList(); }, { passive: true });
function applyTheme(theme) { document.documentElement.dataset.theme = theme; $('#theme-toggle').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon'); }
$('#theme-toggle').onclick = () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; applyTheme(theme); saveSetting('archive-theme', theme); };
fillIcons(); applyTheme(readSetting('archive-theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openSearch(); } if (event.key === 'Escape') closeSidebar(); });
window.addEventListener('hashchange', loadRoute);
async function init() {
  try {
    if (!window.marked || !window.DOMPurify) throw new Error('Markdown 依赖未加载，请先运行 npm install，再刷新页面。');
    state.stats = await api('/api/stats');
    await Promise.all([loadList(true), loadRoute()]);
  } catch (e) { errorView(e); }
}
init();
