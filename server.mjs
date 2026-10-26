import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { recover, projectRoot } from './scripts/recover.mjs';

export async function startServer({ output = join(projectRoot, 'recovered'), port = Number(process.env.PORT || 5183), autoRecover = true, quiet = false } = {}) {
  output = resolve(output);
  if (!existsSync(join(output, 'archive.sqlite'))) {
    if (!autoRecover) throw new Error('请先运行 npm run recover');
    recover({ output });
  }
  const worker = new Worker(new URL('./lib/query-worker.mjs', import.meta.url), { workerData: { database: join(output, 'archive.sqlite') } });
  let nextRequest = 0, workerFailure;
  const pending = new Map();
  worker.on('message', ({ requestId, result, error }) => {
    const p = pending.get(requestId); pending.delete(requestId);
    if (p) error ? p.reject(new Error(error)) : p.resolve(result);
  });
  const failPending = e => { workerFailure = e; for (const p of pending.values()) p.reject(e); pending.clear(); };
  worker.on('error', failPending);
  worker.on('exit', code => failPending(new Error(`查询进程已退出 (${code})`)));
  function query(op, params = {}) {
    if (workerFailure) return Promise.reject(workerFailure);
    if (pending.size > 100) return Promise.reject(new Error('请求过多，请稍后重试'));
    return new Promise((resolve, reject) => { const requestId = ++nextRequest; pending.set(requestId, { resolve, reject }); worker.postMessage({ requestId, op, params }); });
  }
  const compress = promisify(gzip);
  const staticFiles = new Map([
    ['/', ['public/index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['public/style.css', 'text/css; charset=utf-8']],
    ['/vendor/marked.js', ['node_modules/marked/lib/marked.umd.js', 'text/javascript; charset=utf-8']],
    ['/vendor/purify.js', ['node_modules/dompurify/dist/purify.min.js', 'text/javascript; charset=utf-8']],
  ]);
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader('Cache-Control', 'no-store');
    const send = async (value, status = 200) => {
      let body = Buffer.from(JSON.stringify(value));
      if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && body.length > 2048) { body = await compress(body); res.setHeader('Content-Encoding', 'gzip'); }
      if (res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, Vary: 'Accept-Encoding' });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    try {
      const host = req.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) return await send({ error: '仅允许本机访问' }, 403);
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return await send({ error: '不允许跨域访问' }, 403);
      if (req.method !== 'GET' && req.method !== 'HEAD') return await send({ error: '只支持读取' }, 405);
      const url = new URL(req.url, `http://${host}`), params = Object.fromEntries(url.searchParams);
      if (params.q?.length > 200) return await send({ error: '搜索关键词最多 200 字符' }, 400);
      const path = url.pathname;
      if (path === '/api/stats') return await send(await query('stats'));
      if (path === '/api/conversations') return await send(await query('conversations', params));
      if (path === '/api/search') return await send(await query('search', params));
      let match;
      if ((match = path.match(/^\/api\/conversations\/([^/]+)(\/messages)?$/))) {
        const result = await query(match[2] ? 'messages' : 'conversation', { ...params, id: decodeURIComponent(match[1]) });
        return await send(result || { error: '找不到会话' }, result ? 200 : 404);
      }
      if ((match = path.match(/^\/api\/messages\/([^/]+)$/))) {
        const result = await query('message', { id: decodeURIComponent(match[1]) });
        return await send(result || { error: '找不到消息' }, result ? 200 : 404);
      }
      if ((match = path.match(/^\/api\/export\/([^/]+)\/(json|md)$/))) {
        const conv = await query('conversation', { id: decodeURIComponent(match[1]) });
        if (!conv) return await send({ error: '找不到会话' }, 404);
        const kind = match[2], file = join(output, kind === 'md' ? 'markdown' : 'conversations', `${conv.exportName}.${kind}`);
        res.writeHead(200, { 'Content-Type': kind === 'md' ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${conv.exportName}.${kind}"`, 'Content-Length': statSync(file).size });
        createReadStream(file).on('error', () => res.destroy()).pipe(res); return;
      }
      if (path === '/api/report') return await send(await query('stats'));
      if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      const asset = staticFiles.get(path);
      if (!asset) return await send({ error: '找不到页面' }, 404);
      const file = join(projectRoot, asset[0]);
      if (!existsSync(file)) return await send({ error: '缺少前端依赖，请先运行 npm install' }, 503);
      const info = statSync(file), etag = `"${info.size}-${info.mtimeMs}"`;
      res.setHeader('ETag', etag); res.setHeader('Cache-Control', 'private, no-cache');
      if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
      res.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': info.size });
      if (req.method === 'HEAD') res.end();
      else createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch (e) {
      if (!quiet) console.error('请求失败：', e.message);
      if (!res.headersSent) await send({ error: e instanceof URIError ? '无效的路径编码' : '读取失败，请检查服务端日志' }, e instanceof URIError ? 400 : 500);
      else res.destroy();
    }
  });
  let workerTermination;
  server.on('close', () => { workerTermination = worker.terminate(); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  }).catch(async e => { await worker.terminate(); throw e; });
  const address = `http://127.0.0.1:${server.address().port}`;
  if (!quiet) console.log(`聊天档案已就绪：${address}\n按 Ctrl+C 停止服务。`);
  async function close() {
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await (workerTermination || worker.terminate());
  }
  return { server, address, query, close };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    const options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--out' && args[i + 1]) options.output = args[++i];
      else if (args[i] === '--port' && /^\d+$/.test(args[i + 1] || '')) options.port = Number(args[++i]);
      else throw new Error('用法：node server.mjs [--out 输出目录] [--port 端口]');
    }
    const { server } = await startServer(options);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
