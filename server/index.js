import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, HOST, MAX_FILE_BYTES, safeJoin, ensureDirs, APP_NAME } from './config.js';
import { readTextFile, escapeHtml, Emitter } from './utils.js';
import { listProjects, addProject, removeProject, getProject, listHistory, loadHistorySnapshot, loadAiConfig, saveAiConfig } from './storage/store.js';
import { Analyzer } from './analysis/analyzer.js';
import { buildSymbolGraph } from './analysis/symbolGraph.js';
import { ProjectWatcher } from './storage/watcher.js';
import { gitInfo } from './git/gitService.js';
import { AiService } from './ai/aiService.js';

ensureDirs();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');

const app = express();
app.use(express.json({ limit: '2mb' }));

const analyzer = new Analyzer();
const ai = new AiService(analyzer);
const bus = new Emitter();
const watchers = new Map();
const symbolGraphCache = new Map();

function broadcast(projectId, event, data) {
  bus.emit('evt:' + projectId, { event, data, ts: Date.now() });
}

async function runScan(project, res) {
  const ctrl = new AbortController();
  analyzer.scanning.set(project.id, ctrl);
  broadcast(project.id, 'scan-start', {});
  try {
    const result = await analyzer.scan(project, {
      signal: ctrl.signal,
      onProgress: (p) => broadcast(project.id, 'progress', p),
    });
    symbolGraphCache.delete(project.id);
    broadcast(project.id, 'graph', { stats: result.stats, scannedAt: result.scannedAt });
    await startWatcher(project);
    res?.json({ ok: true, stats: result.stats });
  } catch (e) {
    if (e.cancelled) {
      broadcast(project.id, 'scan-cancelled', {});
      res?.status(200).json({ ok: true, cancelled: true });
    } else {
      console.error('scan error:', e);
      broadcast(project.id, 'scan-error', { message: String(e.message || e) });
      res?.status(500).json({ ok: false, error: String(e.message || e) });
    }
  } finally {
    analyzer.scanning.delete(project.id);
  }
}

async function startWatcher(project) {
  if (watchers.has(project.id)) return;
  const w = new ProjectWatcher(project.rootPath, async () => {
    const result = analyzer.getResult(project.id);
    if (!result) return;
    broadcast(project.id, 'watch', { message: 'Обнаружены изменения файлов — инкрементальное обновление…' });
    try {
      const r = await analyzer.scan(project, { onProgress: (p) => broadcast(project.id, 'progress', p) });
      symbolGraphCache.delete(project.id);
      broadcast(project.id, 'graph', { stats: r.stats, scannedAt: r.scannedAt, incremental: true });
    } catch (e) { if (!e.cancelled) broadcast(project.id, 'scan-error', { message: String(e.message || e) }); }
  });
  await w.start();
  watchers.set(project.id, w);
}

// ---------- projects ----------
app.get('/api/health', (req, res) => res.json({ ok: true, app: APP_NAME, version: '1.0.0' }));

app.get('/api/projects', (req, res) => {
  const projects = listProjects().map((p) => {
    const result = analyzer.getResult(p.id);
    return { ...p, scanning: analyzer.scanning.has(p.id), stats: result?.stats || null, fileCount: result ? result.files.size : null };
  });
  res.json(projects);
});

app.post('/api/projects', (req, res) => {
  const { path: p, name } = req.body || {};
  if (!p || typeof p !== 'string') return res.status(400).json({ error: 'path required' });
  const abs = path.resolve(p);
  let st;
  try { st = fs.statSync(abs); } catch { return res.status(400).json({ error: 'Путь не существует: ' + abs }); }
  if (!st.isDirectory()) return res.status(400).json({ error: 'Путь не является директорией' });
  // refuse to open the app's own data dir
  const proj = addProject(abs, name);
  res.json(proj);
});

app.delete('/api/projects/:id', (req, res) => {
  removeProject(req.params.id);
  const w = watchers.get(req.params.id);
  if (w) { w.close(); watchers.delete(req.params.id); }
  analyzer.results.delete(req.params.id);
  res.json({ ok: true });
});

app.post('/api/projects/:id/scan', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'project not found' });
  if (analyzer.scanning.has(project.id)) return res.status(409).json({ error: 'scan already running' });
  runScan(project, res);
});

app.post('/api/projects/:id/cancel', (req, res) => {
  analyzer.cancel(req.params.id);
  res.json({ ok: true });
});

app.get('/api/projects/:id/events', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  const off = bus.on('evt:' + project.id, ({ event, data }) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  });
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(ping); off(); });
});

app.get('/api/projects/:id/status', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  const result = analyzer.getResult(project.id);
  res.json({
    project,
    scanning: analyzer.scanning.has(project.id),
    hasResult: !!result,
    scannedAt: result?.scannedAt || project.lastScanAt || null,
    stats: result?.stats || null,
    watching: watchers.has(project.id),
  });
});

// ---------- graph ----------
function getResultOr404(req, res) {
  const project = getProject(req.params.id);
  const result = project && analyzer.getResult(project.id);
  if (!project) { res.status(404).json({ error: 'project not found' }); return null; }
  if (!result) { res.status(409).json({ error: 'project not scanned yet', needScan: true }); return null; }
  return { project, result };
}

app.get('/api/projects/:id/graph', (req, res) => {
  const ctx = getResultOr404(req, res);
  if (!ctx) return;
  const { result } = ctx;
  const level = req.query.level || 'files';
  if (level === 'symbols') {
    let sg = symbolGraphCache.get(result.projectId);
    if (!sg) { sg = buildSymbolGraph(result); symbolGraphCache.set(result.projectId, sg); }
    return res.json({ ...sg, stats: result.stats, risks: result.risks, scannedAt: result.scannedAt });
  }
  const g = result.graph.toJSON();
  res.json({ ...g, stats: result.stats, risks: result.risks, scannedAt: result.scannedAt, project: { id: result.projectId, name: result.name, rootPath: result.rootPath } });
});

app.get('/api/projects/:id/tree', (req, res) => {
  const ctx = getResultOr404(req, res);
  if (!ctx) return;
  const { result } = ctx;
  const root = { name: result.name, path: '', children: [], type: 'dir' };
  const dirMap = new Map([['', root]]);
  const paths = [...result.files.keys()].sort();
  for (const p of paths) {
    const parts = p.split('/');
    let cur = '';
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      const key = cur ? cur + '/' + seg : seg;
      if (!dirMap.has(key)) {
        const node = { name: seg, path: key, children: [], type: i === parts.length - 1 ? 'file' : 'dir' };
        dirMap.get(cur).children.push(node);
        dirMap.set(key, node);
        if (node.type === 'file') {
          const f = result.files.get(p);
          node.lang = f?.lang; node.loc = f?.loc || 0; node.category = result.graph.nodes.get(p)?.category; node.risks = result.graph.nodes.get(p)?.risk || [];
        }
      }
      cur = key;
    }
  }
  res.json(root);
});

app.get('/api/projects/:id/file', async (req, res) => {
  const ctx = getResultOr404(req, res);
  if (!ctx) return;
  const { project, result } = ctx;
  const rel = String(req.query.path || '');
  const abs = safeJoin(project.rootPath, rel);
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  let st;
  try { st = fs.statSync(abs); } catch { return res.status(404).json({ error: 'file not found' }); }
  if (!st.isFile()) return res.status(400).json({ error: 'not a file' });
  if (st.size > 2_000_000) return res.status(413).json({ error: 'file too large to display' });
  const text = await readTextFile(abs, MAX_FILE_BYTES * 2);
  const facts = result.files.get(rel);
  res.json({
    path: rel,
    exists: true,
    size: st.size,
    truncated: text === null ? false : st.size > MAX_FILE_BYTES * 2,
    binary: text === null,
    content: text,
    lang: facts?.lang || null,
    loc: facts?.loc || null,
    symbols: facts?.symbols || [],
    imports: facts?.imports || [],
    exports: facts?.exports || [],
    routes: facts?.routes || [],
    network: facts?.network || [],
    db: facts?.db || [],
    events: facts?.events || [],
    classes: facts?.classes || [],
    components: facts?.components || [],
    hasSecrets: !!facts?.hasSecrets,
    node: result.graph.nodes.get(rel) || null,
  });
});

app.get('/api/projects/:id/search', (req, res) => {
  const ctx = getResultOr404(req, res);
  if (!ctx) return;
  const { result } = ctx;
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q || q.length < 2) return res.json({ files: [], symbols: [], routes: [] });
  const out = { files: [], symbols: [], routes: [] };
  for (const [p, f] of result.files) {
    if (p.toLowerCase().includes(q) && out.files.length < 60) out.files.push({ path: p, lang: f.lang, loc: f.loc, category: result.graph.nodes.get(p)?.category });
    for (const s of f.symbols || []) {
      if (s.name.toLowerCase().includes(q) && out.symbols.length < 120) out.symbols.push({ name: s.name, kind: s.kind, file: p, line: s.line, signature: s.signature });
    }
    for (const r of f.routes || []) {
      if ((r.path + ' ' + (r.handler || '')).toLowerCase().includes(q) && out.routes.length < 60) out.routes.push({ ...r, file: p });
    }
  }
  res.json(out);
});

app.get('/api/projects/:id/impact', (req, res) => {
  const ctx = getResultOr404(req, res);
  if (!ctx) return;
  const { result } = ctx;
  const p = String(req.query.path || '');
  const symbol = String(req.query.symbol || '');
  let start = p;
  if (symbol && p) {
    const f = result.files.get(p);
    const s = f?.symbols?.find((x) => x.name === symbol);
    if (s) start = p; // impact is computed at file level, symbol info attached
  }
  const impact = impactOf(result, start);
  res.json({ ...impact, symbol: symbol || null });
});

function impactOf(result, startId) {
  const g = result.graph;
  if (!g.nodes.has(startId)) return { start: startId, impacted: [], edges: [], found: false };
  const visited = new Map([[startId, 0]]);
  const queue = [[startId, 0]];
  const depEdges = [];
  while (queue.length) {
    const [id, depth] = queue.shift();
    if (depth >= 12) continue;
    for (const e of g.radj.get(id) || []) {
      if (!['import', 'extends', 'call', 'http'].includes(e.kind)) continue;
      depEdges.push(e);
      if (!visited.has(e.from)) { visited.set(e.from, depth + 1); queue.push([e.from, depth + 1]); }
    }
  }
  const impacted = [...visited.keys()].filter((id) => id !== startId);
  return {
    start: startId, found: true, impacted,
    impactCount: impacted.length,
    depth: Object.fromEntries(visited),
    edges: depEdges.filter((e) => visited.has(e.from)).map((e) => ({ from: e.from, to: e.to, kind: e.kind, confidence: e.confidence, detail: e.detail })),
  };
}

app.get('/api/projects/:id/stats', (req, res) => {
  const ctx = getResultOr404(req, res);
  if (!ctx) return;
  res.json(ctx.result.stats);
});

app.get('/api/projects/:id/risks', (req, res) => {
  const ctx = getResultOr404(req, res);
  if (!ctx) return;
  res.json(ctx.result.risks);
});

app.get('/api/projects/:id/routes', (req, res) => {
  const ctx = getResultOr404(req, res);
  if (!ctx) return;
  res.json(ctx.result.graph.allRoutes || []);
});

// ---------- export / report ----------
app.get('/api/projects/:id/export', (req, res) => {
  const ctx = getResultOr404(req, res);
  if (!ctx) return;
  const { result } = ctx;
  const format = req.query.format || 'json';
  if (format === 'json') {
    res.setHeader('Content-Disposition', `attachment; filename="${result.name}-graph.json"`);
    return res.json(result.graph.toJSON());
  }
  if (format === 'svg') {
    const g = result.graph;
    const nodes = [...g.nodes.values()].filter((n) => n.kind === 'file');
    const edges = g.edges.filter((e) => g.nodes.get(e.from)?.kind === 'file' && g.nodes.get(e.to)?.kind === 'file');
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const n of nodes) { const p = n.position || { x: 0, y: 0 }; minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    const W = 1600, H = 1000, pad = 40;
    const sx = (x) => pad + (maxX === minX ? W / 2 : (x - minX) / (maxX - minX) * (W - 2 * pad));
    const sy = (y) => pad + (maxY === minY ? H / 2 : (y - minY) / (maxY - minY) * (H - 2 * pad));
    const colors = { frontend: '#4cc2ff', backend: '#ffb454', api: '#c792ea', database: '#82aaff', service: '#7fdbca', config: '#8b949e', test: '#6e7681', docs: '#d2a8ff', other: '#adbac7' };
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="monospace">`;
    svg += `<rect width="${W}" height="${H}" fill="#0d1117"/>`;
    for (const e of edges) {
      const a = g.nodes.get(e.from), b = g.nodes.get(e.to);
      if (!a?.position || !b?.position) continue;
      svg += `<line x1="${sx(a.position.x)}" y1="${sy(a.position.y)}" x2="${sx(b.position.x)}" y2="${sy(b.position.y)}" stroke="#30363d" stroke-width="1"/>`;
    }
    for (const n of nodes) {
      const p = n.position || { x: 0, y: 0 };
      const r = 3 + Math.min(10, (n.metrics?.importance || 0) / 12);
      svg += `<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="${r}" fill="${colors[n.category] || '#adbac7'}"><title>${escapeHtml(n.path)} (${n.loc} строк)</title></circle>`;
    }
    svg += '</svg>';
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Content-Disposition', `attachment; filename="${result.name}-graph.svg"`);
    return res.send(svg);
  }
  res.status(400).json({ error: 'unknown format' });
});

app.get('/api/projects/:id/report', (req, res) => {
  const ctx = getResultOr404(req, res);
  if (!ctx) return;
  const { result } = ctx;
  const s = result.stats;
  const lines = [];
  lines.push(`# Архитектурный отчёт: ${result.name}`);
  lines.push(`\nДата анализа: ${new Date(result.scannedAt).toISOString()}`);
  lines.push(`\n## Общая статистика`);
  lines.push(`- Файлов: ${s.files} (пропущено: ${s.skipped}), строк кода: ${s.loc}`);
  lines.push(`- Символов: ${s.symbols}, узлов графа: ${s.nodes}, рёбер: ${s.edges}`);
  lines.push(`- Языки: ${Object.entries(s.byLang).map(([k, v]) => `${k} (${v})`).join(', ')}`);
  lines.push(`- API-роутов: ${s.routes}, внешних пакетов: ${s.externalPackages}, неразрешённых импортов: ${s.unresolvedImports}`);
  lines.push(`\n## Рёбра по типам: ${Object.entries(s.edgeKinds).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
  lines.push(`\n## Hub-компоненты (наиболее используемые)`);
  for (const h of s.hubs) lines.push(`- \`${h.path}\` — входящих зависимостей: ${h.importedBy}, строк: ${h.loc}`);
  lines.push(`\n## Самые сложные компоненты`);
  for (const c of s.mostComplex) lines.push(`- \`${c.path}\` — сложность ${c.complexity}, строк: ${c.loc}`);
  lines.push(`\n## Риски (${s.risks})`);
  const sevOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  for (const r of [...result.risks].sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]).slice(0, 200)) {
    lines.push(`- [${r.severity.toUpperCase()}] **${r.type}** — ${r.message} ${r.nodeIds?.length ? `(\`${r.nodeIds.slice(0, 3).join('`, `')}\`)` : ''}`);
  }
  lines.push(`\n## API endpoints`);
  for (const r of (result.graph.allRoutes || []).slice(0, 100)) lines.push(`- \`${r.method} ${r.path}\` → ${r.handler || '?'} — \`${r.file}:${r.line}\``);
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${result.name}-report.md"`);
  res.send(lines.join('\n'));
});

// ---------- history ----------
app.get('/api/projects/:id/history', (req, res) => {
  res.json(listHistory(req.params.id));
});

app.get('/api/projects/:id/history/compare', (req, res) => {
  const a = loadHistorySnapshot(req.params.id, req.query.a);
  const b = loadHistorySnapshot(req.params.id, req.query.b);
  if (!a || !b) return res.status(404).json({ error: 'snapshot not found' });
  res.json(analyzer.compareSnapshots(a, b));
});

app.get('/api/projects/:id/git', async (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  res.json(await gitInfo(project.rootPath));
});

// ---------- AI ----------
app.get('/api/ai/config', (req, res) => res.json(ai.config()));

app.put('/api/ai/config', (req, res) => {
  const cur = loadAiConfig();
  const next = { ...cur, ...(req.body || {}) };
  if (next.apiKey === '••••••') next.apiKey = cur.apiKey;
  saveAiConfig(next);
  res.json(ai.config());
});

app.post('/api/projects/:id/ask', async (req, res) => {
  const ctx = getResultOr404(req, res);
  if (!ctx) return;
  const { result } = ctx;
  const question = String((req.body || {}).question || '').trim();
  if (!question) return res.status(400).json({ error: 'question required' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    let full = '';
    for await (const chunk of ai.ask(result, question)) {
      full += chunk;
      send('token', { text: chunk });
    }
    send('done', { full });
  } catch (e) {
    send('error', { message: String(e.message || e) });
  }
  res.end();
});

// ---------- static ----------
app.use(express.static(PUBLIC, { maxAge: '1h', index: 'index.html' }));
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

app.listen(PORT, HOST, () => {
  console.log(`CodeBrain запущен: http://${HOST}:${PORT}`);
});

process.on('SIGINT', () => { analyzer.terminate(); process.exit(0); });
process.on('SIGTERM', () => { analyzer.terminate(); process.exit(0); });
