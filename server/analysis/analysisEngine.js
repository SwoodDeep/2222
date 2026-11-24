import { hashString } from '../utils.js';
import { SECRET_LINE_RE, SECRET_FILE_PATTERNS } from '../config.js';

export class AnalysisEngine {
  constructor(graph, files) {
    this.graph = graph;
    this.files = files;
    this.risks = [];
  }

  risk(type, severity, message, nodeIds, evidence) {
    this.risks.push({ id: 'r' + this.risks.length, type, severity, message, nodeIds, evidence: evidence?.slice(0, 12) });
  }

  run() {
    const PROF = !!process.env.CODEBRAIN_PROFILE;
    const steps = ['detectCycles', 'detectUnused', 'detectComplexity', 'detectDuplication', 'detectSecrets', 'detectOrphans'];
    for (const s of steps) {
      const t = Date.now();
      this[s]();
      if (PROF) console.error(`[prof:analysis] ${s}: ${Date.now() - t}ms`);
    }
    return this.risks;
  }

  detectCycles() {
    const g = this.graph;
    const index = new Map();
    const low = new Map();
    const onStack = new Set();
    const stack = [];
    let counter = 0;
    const sccs = [];
    const importAdj = new Map();
    for (const [id] of g.nodes) importAdj.set(id, []);
    for (const e of g.edges) if ((e.kind === 'import' || e.kind === 'extends') && e.confidence === 'certain') importAdj.get(e.from)?.push(e.to);

    const strong = (v) => {
      index.set(v, counter); low.set(v, counter); counter++;
      stack.push(v); onStack.add(v);
      for (const w of importAdj.get(v) || []) {
        if (!index.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
      }
      if (low.get(v) === index.get(v)) {
        const scc = [];
        let w;
        do { w = stack.pop(); onStack.delete(w); scc.push(w); } while (w !== v);
        if (scc.length > 1 || (importAdj.get(v) || []).includes(v)) sccs.push(scc);
      }
    };
    for (const [id] of g.nodes) if (!index.has(id)) strong(id);

    for (const scc of sccs) {
      this.risk('cycle', 'high', `Циклическая зависимость: ${scc.length} модулей зависят друг от друга`, scc, scc.slice(0, 6));
      for (const id of scc) if (g.nodes.get(id)) g.nodes.get(id).risk.push('cycle');
    }
  }

  detectUnused() {
    const g = this.graph;
    const files = this.files;
    // names imported from each file by other files
    const importedNames = new Map(); // file -> Set(names)
    for (const [p, facts] of files) {
      for (const imp of facts.imports || []) {
        const r = g.resolver.resolve(p, imp);
        if (!r.file) continue;
        if (!importedNames.has(r.file)) importedNames.set(r.file, new Set());
        for (const s of imp.specifiers || []) importedNames.get(r.file).add(s.imported);
      }
    }
    const calledNames = new Set();
    for (const [, facts] of files) for (const c of facts.calls || []) calledNames.add(c.name);

    for (const [p, facts] of files) {
      const exported = (facts.exports || []).filter((e) => e.name !== 'default');
      if (!exported.length) continue;
      const used = importedNames.get(p) || new Set();
      const unused = exported.filter((e) => !used.has(e.name) && !calledNames.has(e.name) && !/^(main|index|App|default)$/.test(e.name));
      if (unused.length) {
        this.risk('unused-code', 'low', `Потенциально неиспользуемые экспорты: ${unused.map((u) => u.name).join(', ')}`, [p], unused.map((u) => `${p}:${u.line}`));
        const node = g.nodes.get(p);
        if (node) node.risk.push('unused');
      }
    }
  }

  detectComplexity() {
    const g = this.graph;
    for (const [p, facts] of this.files) {
      if (facts.skipped) continue;
      let total = 1;
      const hot = [];
      for (const s of facts.symbols || []) {
        if (s.complexity) {
          total += s.complexity - 1;
          if (s.complexity >= 15) hot.push({ name: s.name, line: s.line, complexity: s.complexity });
        }
      }
      const node = g.nodes.get(p);
      if (node) node.metrics.complexity = total;
      if (hot.length) {
        this.risk('complexity', 'medium', `Сложные функции (цикломатическая сложность ≥ 15): ${hot.map((h) => `${h.name} (${h.complexity})`).join(', ')}`, [p], hot.map((h) => `${p}:${h.line}`));
        if (node) node.risk.push('complex');
      }
      if (total >= 60 && (facts.loc || 0) >= 200) {
        this.risk('god-component', 'medium', `Перегруженный компонент: сложность ${total}, строк ${facts.loc}`, [p], [p]);
        if (node) node.risk.push('god');
      }
    }
  }

  detectDuplication() {
    const files = this.files;
    const shingleMap = new Map(); // hash -> [files]
    const perFile = new Map();
    for (const [p, facts] of files) {
      if (facts.skipped || !facts.shingleHashes?.length) continue;
      perFile.set(p, facts.shingleHashes);
      for (const h of facts.shingleHashes) {
        if (!shingleMap.has(h)) shingleMap.set(h, []);
        shingleMap.get(h).push(p);
      }
    }
    // count shared shingles per file (no O(k^2) pairwise loops)
    const sharedCount = new Map();
    const sharedWith = new Map();
    for (const [h, list] of shingleMap) {
      const uniq = [...new Set(list)];
      if (uniq.length < 2) continue;
      for (const f of uniq) {
        sharedCount.set(f, (sharedCount.get(f) || 0) + 1);
        if (uniq.length <= 50) {
          if (!sharedWith.has(f)) sharedWith.set(f, new Set());
          for (const o of uniq) if (o !== f) sharedWith.get(f).add(o);
        }
      }
    }
    for (const [f, count] of sharedCount) {
      if (count >= 3) {
        const others = [...(sharedWith.get(f) || [])].slice(0, 4);
        this.risk('duplication', 'medium', `Дублирование логики: ${count} общих блоков${others.length ? ` (в т.ч. ${others.join(', ')})` : ''}`, [f], [f]);
        const node = this.graph.nodes.get(f);
        if (node) node.risk.push('duplication');
      }
    }
  }

  detectSecrets() {
    for (const [p, facts] of this.files) {
      if (SECRET_FILE_PATTERNS.some((re) => re.test(p))) {
        this.risk('secret', 'critical', 'Файл потенциально содержит секреты (.env/ключи) — исключён из AI-контекста', [p], [p]);
        const node = this.graph.nodes.get(p);
        if (node) { node.hasSecrets = true; node.risk.push('secret'); }
        continue;
      }
      if (facts.skipped) continue;
      const count = facts.secretLineCount || 0;
      if (count > 0) {
        this.risk('secret', 'high', `Обнаружены строки, похожие на секреты/API-ключи (${count}+)`, [p], [p]);
        const node = this.graph.nodes.get(p);
        if (node) { node.hasSecrets = true; node.risk.push('secret'); }
      }
    }
  }

  detectOrphans() {
    const g = this.graph;
    const entryPatterns = /(^|\/)(index|main|app|server|cli|manage|wsgi|gunicorn|__main__)\.[^.]+$|^package\.json$|^Dockerfile$/;
    for (const [id, node] of g.nodes) {
      if (node.kind !== 'file' || node.category === 'config' || node.category === 'docs') continue;
      if (entryPatterns.test(node.path)) continue;
      const inn = g.radj.get(id)?.filter((e) => (e.kind === 'import' || e.kind === 'extends') && e.confidence === 'certain').length || 0;
      const symbolEntry = node._facts?.symbols?.some((s) => s.kind === 'entrypoint');
      if (inn === 0 && !symbolEntry && node.category !== 'test') {
        this.risk('orphan', 'info', 'Файл не импортируется ни одним модулем (возможная точка входа или мёртвый код)', [id], [id]);
      }
    }
  }

  impact(startId) {
    const g = this.graph;
    if (!g.nodes.has(startId)) return null;
    const visited = new Map([[startId, 0]]);
    const queue = [[startId, 0]];
    const depEdges = [];
    while (queue.length) {
      const [id, depth] = queue.shift();
      if (depth >= 12) continue;
      for (const e of g.radj.get(id) || []) {
        if (e.kind !== 'import' && e.kind !== 'extends' && e.kind !== 'call' && e.kind !== 'http') continue;
        depEdges.push(e);
        if (!visited.has(e.from)) {
          visited.set(e.from, depth + 1);
          queue.push([e.from, depth + 1]);
        }
      }
    }
    const impacted = [...visited.keys()].filter((id) => id !== startId);
    return {
      start: startId,
      impacted,
      depth: visited,
      edges: depEdges.filter((e) => visited.has(e.from)).map((e) => ({ from: e.from, to: e.to, kind: e.kind, confidence: e.confidence })),
    };
  }

  stats() {
    const g = this.graph;
    const byLang = {};
    let loc = 0, symbols = 0;
    for (const [p, f] of this.files) {
      if (f.skipped) continue;
      byLang[f.lang] = (byLang[f.lang] || 0) + 1;
      loc += f.loc || 0;
      symbols += f.symbols?.length || 0;
    }
    const bySeverity = {};
    for (const r of this.risks) bySeverity[r.severity] = (bySeverity[r.severity] || 0) + 1;
    const hubs = [...g.nodes.values()].filter((n) => n.kind === 'file')
      .sort((a, b) => (b.metrics.importedBy || 0) - (a.metrics.importedBy || 0)).slice(0, 10)
      .map((n) => ({ path: n.path, importedBy: n.metrics.importedBy, loc: n.loc, category: n.category }));
    const complex = [...g.nodes.values()].filter((n) => n.kind === 'file')
      .sort((a, b) => (b.metrics.complexity || 0) - (a.metrics.complexity || 0)).slice(0, 10)
      .map((n) => ({ path: n.path, complexity: n.metrics.complexity, loc: n.loc }));
    const edgeKinds = {};
    for (const e of g.edges) edgeKinds[e.kind] = (edgeKinds[e.kind] || 0) + 1;
    return {
      files: this.files.size,
      parsed: [...this.files.values()].filter((f) => !f.skipped).length,
      skipped: [...this.files.values()].filter((f) => f.skipped).length,
      loc, symbols,
      nodes: g.nodes.size,
      edges: g.edges.length,
      edgeKinds,
      byLang,
      routes: g.allRoutes?.length || 0,
      externalPackages: [...g.nodes.values()].filter((n) => n.kind === 'package').length,
      unresolvedImports: g.unresolved?.length || 0,
      risks: this.risks.length,
      bySeverity,
      hubs,
      mostComplex: complex,
      cycles: this.risks.filter((r) => r.type === 'cycle').length,
    };
  }
}
