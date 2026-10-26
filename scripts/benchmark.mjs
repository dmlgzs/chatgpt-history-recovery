import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../server.mjs';
import { projectRoot } from './recover.mjs';

const running = await startServer({ port: 0, autoRecover: false, quiet: true });
try {
  const largest = await (await fetch(`${running.address}/api/conversations?sort=messages&limit=1`)).json();
  const id = largest.items[0]?.id;
  const cases = [
    ['会话列表（60 条）', '/api/conversations?limit=60'],
    ['消息段（24 条，长会话）', `/api/conversations/${encodeURIComponent(id)}/messages?limit=24`],
    ['中文索引子串搜索', '/api/search?q=' + encodeURIComponent('聊天记录')],
    ['英文索引子串搜索', '/api/search?q=windows'],
    ['两字无匹配扫描', '/api/search?q=' + encodeURIComponent('龘龘')],
  ];
  const results = [];
  for (const [name, path] of cases) {
    const samples = []; let bodyBytes = 0;
    for (let i = 0; i < 11; i++) {
      const start = performance.now(), response = await fetch(running.address + path);
      if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
      const body = await response.text(); bodyBytes = Buffer.byteLength(body);
      if (i > 0) samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    results.push({ name, samples: samples.length, medianMs: +samples[5].toFixed(2), p95Ms: +samples[9].toFixed(2), responseBytesUncompressed: bodyBytes });
  }
  const report = { measuredAt: new Date().toISOString(), node: process.version, methodology: 'Local HTTP with JSON transfer/decompression; one warmup plus ten sequential requests per case. Not a browser frame-rate or concurrent load test.', results };
  mkdirSync(join(projectRoot, '.test-output'), { recursive: true });
  writeFileSync(join(projectRoot, '.test-output', 'performance.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await running.close(); }
