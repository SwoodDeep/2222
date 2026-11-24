import path from 'node:path';
import { scanFiles } from '../scanner/fileScanner.js';
import { ParsePool } from '../workers/pool.js';
import { GraphEngine } from './graphEngine.js';
import { AnalysisEngine } from './analysisEngine.js';
import { loadCache, saveCache, saveHistorySnapshot, updateProject } from '../storage/store.js';
import { hashString } from '../utils.js';

export class ScanCancelled extends Error {
  constructor() { super('Scan cancelled'); this.cancelled = true; }
}

export class Analyzer {
  constructor() {
    this.pool = new ParsePool();
    this.results = new Map(); // projectId -> result
    this.scanning = new Map(); // projectId -> AbortController
  }

  cancel(projectId) {
    const c = this.scanning.get(projectId);
    if (c) c.abort();
  }

  getResult(projectId) {
    return this.results.get(projectId) || null;
  }

  async scan(project, { onProgress, signal } = {}) {
    const root = project.rootPath;
    const report = (phase, extra = {}) => onProgress?.({ phase, projectId: project.id, ...extra });

    report('scanning', { message: 'Сканирование файловой системы…' });
    const files = await scanFiles(root, (p) => report('scanning', p));
    if (signal?.aborted) throw new ScanCancelled();

    const cache = loadCache(root);
    const cached = cache.files || {};
    const toParse = [];
    const filesMap = new Map();
    for (const f of files) {
      const key = f.path;
      const c = cached[key];
      if (c && c.mtimeMs === f.mtimeMs && c.size === f.size && c.facts) {
        filesMap.set(key, c.facts);
      } else {
        toParse.push(f);
      }
    }
    // removed files
    const removed = Object.keys(cached).filter((k) => !files.find((f) => f.path === k));
    for (const r of removed) delete cached[r];

    const PROF = !!process.env.CODEBRAIN_PROFILE;
    const mark = (name, t0) => { if (PROF) console.error(`[prof] ${name}: ${Date.now() - t0}ms`); };
    let tp = Date.now();
    report('parsing', { message: `Парсинг ${toParse.length} файлов (кэш: ${filesMap.size})…`, total: toParse.length, done: 0 });
    const parsed = await this.pool.parseAll(toParse, (done, total) => {
      if (signal?.aborted) throw new ScanCancelled();
      report('parsing', { message: `Парсинг… ${done}/${total}`, total, done });
    });
    mark('parse', tp); tp = Date.now();
    if (signal?.aborted) throw new ScanCancelled();

    for (const r of parsed) {
      if (r.skipped) {
        filesMap.set(r.path, { path: r.path, lang: 'binary', size: files.find((f) => f.path === r.path)?.size || 0, loc: 0, symbols: [], imports: [], exports: [], calls: [], classes: [], routes: [], network: [], db: [], events: [], components: [], skipped: true, skipReason: r.reason });
      } else {
        filesMap.set(r.path, r.facts);
      }
    }

    report('graph', { message: 'Построение графа зависимостей…' });
    const graph = new GraphEngine(root, filesMap).build();
    mark('graph', tp); tp = Date.now();

    report('layout', { message: 'Расчёт 3D-раскладки…' });
    graph.layout();
    mark('layout', tp); tp = Date.now();

    report('analysis', { message: 'Анализ: циклы, дубли, сложность, секреты…' });
    const analysis = new AnalysisEngine(graph, filesMap);
    const risks = analysis.run();
    const stats = analysis.stats();
    mark('analysis', tp); tp = Date.now();

    // keep raw text only during analysis; free memory afterwards
    for (const [, f] of filesMap) f.raw = null;

    const result = {
      projectId: project.id,
      rootPath: root,
      name: project.name,
      scannedAt: Date.now(),
      files: filesMap,
      graph,
      risks,
      stats,
    };
    this.results.set(project.id, result);

    // persist cache
    const newCache = { version: cache.version, files: {} };
    for (const [p, f] of filesMap) {
      if (f.skipped) continue;
      const fileEntry = files.find((x) => x.path === p);
      newCache.files[p] = { mtimeMs: fileEntry?.mtimeMs, size: fileEntry?.size, facts: f };
    }
    try { saveCache(root, newCache); } catch { /* cache is best-effort */ }
    mark('saveCache', tp); tp = Date.now();

    // history snapshot
    const fileSummary = {};
    for (const [p, f] of filesMap) fileSummary[p] = { loc: f.loc || 0, sym: f.symbols?.length || 0, h: hashString(p + '|' + (f.loc || 0) + '|' + (f.symbols?.length || 0)) };
    const snapTs = saveHistorySnapshot(project.id, {
      scannedAt: result.scannedAt,
      stats,
      files: fileSummary,
      risks: risks.map((r) => ({ type: r.type, severity: r.severity, nodeIds: r.nodeIds })),
    });
    updateProject(project.id, { lastScanAt: result.scannedAt });

    report('done', { message: 'Готово', stats, historyTs: snapTs });
    return result;
  }

  compareSnapshots(a, b) {
    const fa = a.files || {}, fb = b.files || {};
    const added = Object.keys(fb).filter((k) => !fa[k]);
    const removed = Object.keys(fa).filter((k) => !fb[k]);
    const changed = Object.keys(fa).filter((k) => fb[k] && fa[k].h !== fb[k].h);
    return {
      added, removed, changed,
      statsA: a.stats, statsB: b.stats,
      risksA: (a.risks || []).length, risksB: (b.risks || []).length,
      locDelta: (b.stats?.loc || 0) - (a.stats?.loc || 0),
      fileDelta: (b.stats?.files || 0) - (a.stats?.files || 0),
    };
  }

  terminate() { this.pool.terminate(); }
}
