import path from 'node:path';
import { SymbolIndex } from './symbolIndex.js';
import { DependencyResolver } from './dependencyResolver.js';
import { routeSimilarity, normalizeRoutePath } from '../utils.js';

export const CATEGORIES = ['frontend', 'backend', 'api', 'database', 'service', 'config', 'test', 'docs', 'external', 'virtual', 'other'];

function classify(path, facts) {
  const p = path.toLowerCase();
  const base = path.split('/').pop().toLowerCase();
  if (/\.(test|spec)\.[^.]+$/.test(base) || /(^|\/)(tests?|__tests__|spec|e2e|coverage)\//.test(p) || /^test_/.test(base) || /_test\.[^.]+$/.test(base)) return 'test';
  if (/\.(md|markdown|txt)$/.test(p) || /(^|\/)docs?\//.test(p)) return 'docs';
  if (/\.(sql)$/.test(p)) return 'database';
  if (/\.(json|jsonc|ya?ml|toml|ini|cfg|conf|env|lock)$/.test(p) || ['dockerfile', 'makefile', '.gitignore', '.dockerignore', '.eslintrc', '.prettierrc', '.babelrc'].includes(base) || /(^|\/)\.github\//.test(p) || /(^|\/)(config|settings|properties)\//.test(p)) return 'config';
  if (facts.routes?.length) return 'api';
  const markup = /\.(html?|vue|svelte|css|scss|less)$/.test(p);
  if (markup) return 'frontend';
  if (/\.(jsx?|tsx?|mjs|cjs)$/.test(p)) {
    const serverish = facts.db?.length || facts.network?.length === 0 && /(^|\/)(server|backend|api|routes|controllers|handlers|cmd|internal|pkg)\//.test(p);
    const clientish = /(^|\/)(src|client|web|app|public|pages|components|views|ui|frontend)\//.test(p) || facts.components?.length || facts.events?.some((e) => e.kind === 'addEventListener' || e.kind === 'dom-event');
    if (clientish && !serverish) return 'frontend';
    if (serverish || facts.db?.length || /(^|\/)(services?|workers?|jobs?|tasks?|lib|utils?)\//.test(p)) return facts.db?.length ? 'backend' : 'service';
    return 'other';
  }
  if (['py', 'java', 'go', 'rs', 'cs', 'php', 'rb', 'kt'].some((l) => p.endsWith('.' + l))) {
    if (/(^|\/)(services?|workers?|jobs?|lib|pkg|internal|domain)\//.test(p)) return 'service';
    return 'backend';
  }
  return 'other';
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class GraphEngine {
  constructor(rootPath, files) {
    this.root = rootPath;
    this.files = files; // Map path -> facts
    this.index = new SymbolIndex();
    this.index.build(files);
    this.resolver = new DependencyResolver(rootPath, files);
    this.resolver.setLangs(files);
    this.nodes = new Map();
    this.edges = [];
    this.adj = new Map();
    this.radj = new Map();
  }

  addNode(node) {
    this.nodes.set(node.id, node);
    this.adj.set(node.id, []);
    this.radj.set(node.id, []);
    return node;
  }

  addEdge(from, to, kind, confidence, extra = {}) {
    if (!this.nodes.has(from) || !this.nodes.has(to) || from === to) return null;
    const key = from + '|' + to + '|' + kind;
    const existing = this.edgeByKey?.get(key);
    if (existing) { existing.weight += 1; return existing; }
    const e = { id: 'e' + this.edges.length, from, to, kind, confidence, weight: 1, ...extra };
    this.edges.push(e);
    this.edgeByKey = this.edgeByKey || new Map();
    this.edgeByKey.set(key, e);
    this.adj.get(from).push(e);
    this.radj.get(to).push(e);
    return e;
  }

  build() {
    const files = this.files;
    // file nodes
    for (const [p, facts] of files) {
      const category = facts.skipped ? 'other' : classify(p, facts);
      const imports = facts.imports?.length || 0;
      const node = this.addNode({
        id: p,
        label: p.split('/').pop(),
        path: p,
        kind: 'file',
        category,
        lang: facts.lang,
        loc: facts.loc || 0,
        size: facts.size,
        symbolCount: facts.symbols?.length || 0,
        routeCount: facts.routes?.length || 0,
        hasDb: (facts.db?.length || 0) > 0,
        hasNetwork: (facts.network?.length || 0) > 0,
        hasSecrets: !!facts.hasSecrets,
        skipped: !!facts.skipped,
        metrics: { imports, complexity: 0 },
        risk: [],
      });
      node._facts = facts;
    }

    // resolution + import edges
    const unresolved = [];
    for (const [p, facts] of files) {
      for (const imp of facts.imports || []) {
        if (imp.kind === 'npm-dependency' || imp.kind === 'composer-dependency' || imp.kind === 'manifest-dependency' || imp.kind === 'docker-image') {
          const pkgId = 'pkg:' + imp.source;
          if (!this.nodes.has(pkgId)) this.addNode({ id: pkgId, label: imp.source, path: imp.source, kind: 'package', category: 'external', lang: 'package', loc: 0, metrics: { imports: 0, complexity: 0 }, risk: [] });
          this.addEdge(p, pkgId, 'dependency', 'certain', { line: imp.line });
          continue;
        }
        const r = this.resolver.resolve(p, imp);
        if (r.file) {
          this.addEdge(p, r.file, 'import', 'certain', { line: imp.line, specifiers: imp.specifiers?.map((s) => s.local).slice(0, 8) });
        } else if (r.external) {
          const pkgId = 'pkg:' + r.external;
          if (!this.nodes.has(pkgId)) this.addNode({ id: pkgId, label: r.external, path: r.external, kind: 'package', category: 'external', lang: 'package', loc: 0, metrics: { imports: 0, complexity: 0 }, risk: [] });
          this.addEdge(p, pkgId, imp.kind === 'import' || imp.kind === 'require' ? 'import' : 'dependency', 'certain', { line: imp.line, external: true });
        } else if (r.unresolved) {
          unresolved.push({ from: p, source: imp.source, line: imp.line });
        }
      }
    }

    // extends edges (class inheritance across files)
    for (const [p, facts] of files) {
      for (const cls of facts.classes || []) {
        if (cls.extends) {
          const base = cls.extends.split('.').pop();
          const cands = this.index.lookup(base).filter((c) => c.file !== p && c.symbol.kind === 'class');
          if (cands.length >= 1) this.addEdge(p, cands[0].file, 'extends', 'certain', { line: cls.line, detail: cls.name + ' extends ' + cls.extends });
        }
      }
    }

    // call edges (symbol-name matching, inferred)
    const callEdges = [];
    for (const [p, facts] of files) {
      const seen = new Set();
      for (const call of facts.calls || []) {
        if (seen.has(call.name)) continue;
        seen.add(call.name);
        const cands = this.index.lookup(call.name).filter((c) => c.file !== p);
        if (cands.length === 1) callEdges.push({ from: p, to: cands[0].file, name: call.name, weight: 2 });
        else if (cands.length <= 3) for (const c of cands) callEdges.push({ from: p, to: c.file, name: call.name, weight: 1 });
      }
    }
    for (const ce of callEdges) this.addEdge(ce.from, ce.to, 'call', 'inferred', { detail: ce.name, weight: ce.weight });

    // routes
    const allRoutes = [];
    for (const [p, facts] of files) for (const r of facts.routes || []) allRoutes.push({ file: p, ...r });
    // client network calls → routes
    for (const [p, facts] of files) {
      for (const n of facts.network || []) {
        if (n.url && /^https?:\/\//.test(n.url)) {
          const host = new URL(n.url).host;
          const extId = 'ext:' + host;
          if (!this.nodes.has(extId)) this.addNode({ id: extId, label: host, path: n.url, kind: 'virtual', category: 'external', lang: 'http', loc: 0, metrics: { imports: 0, complexity: 0 }, risk: [] });
          this.addEdge(p, extId, 'http', 'certain', { line: n.line, detail: n.method + ' ' + n.url });
          continue;
        }
        if (n.kind === 'websocket') {
          const wsId = 'ws:websocket';
          if (!this.nodes.has(wsId)) this.addNode({ id: wsId, label: 'WebSocket', path: 'websocket', kind: 'virtual', category: 'virtual', lang: 'ws', loc: 0, metrics: { imports: 0, complexity: 0 }, risk: [] });
          this.addEdge(p, wsId, 'websocket', 'certain', { line: n.line, detail: n.url });
          continue;
        }
        // relative url → match against routes
        if (n.url) {
          let best = null, bestScore = 0;
          for (const r of allRoutes) {
            const s = routeSimilarity(n.url, r.path);
            if (s > bestScore) { bestScore = s; best = r; }
          }
          if (best && bestScore >= 0.75) {
            this.addEdge(p, best.file, 'http', bestScore >= 0.99 ? 'certain' : 'inferred', { line: n.line, detail: `${n.method || 'GET'} ${n.url} → ${best.method} ${best.path}`, route: normalizeRoutePath(best.path) });
          } else {
            const apiId = 'ext:api';
            if (!this.nodes.has(apiId)) this.addNode({ id: apiId, label: 'External API', path: 'api', kind: 'virtual', category: 'external', lang: 'http', loc: 0, metrics: { imports: 0, complexity: 0 }, risk: [] });
            this.addEdge(p, apiId, 'http', 'inferred', { line: n.line, detail: `${n.method || 'GET'} ${n.url}` });
          }
        }
      }
    }
    // db edges
    for (const [p, facts] of files) {
      if (facts.db?.length) {
        const dbId = 'db:database';
        if (!this.nodes.has(dbId)) this.addNode({ id: dbId, label: 'Database', path: 'database', kind: 'virtual', category: 'database', lang: 'db', loc: 0, metrics: { imports: 0, complexity: 0 }, risk: [] });
        this.addEdge(p, dbId, 'db', 'certain', { line: facts.db[0].line, detail: facts.db[0].detail?.slice(0, 80) });
      }
    }

    // metrics: degree, importance
    for (const [id, node] of this.nodes) {
      const out = this.adj.get(id)?.filter((e) => e.kind === 'import' || e.kind === 'extends').length || 0;
      const inn = this.radj.get(id)?.filter((e) => e.kind === 'import' || e.kind === 'extends').length || 0;
      node.metrics.imports = out;
      node.metrics.importedBy = inn;
      node.metrics.degree = out + inn;
      node.metrics.importance = Math.round(100 * (Math.log2(1 + inn) * 2 + Math.log2(1 + out) + Math.log2(1 + (node.loc || 0)) / 3));
    }

    this.unresolved = unresolved;
    this.allRoutes = allRoutes;
    return this;
  }

  clusters() {
    const map = new Map();
    for (const [id, node] of this.nodes) {
      if (node.kind !== 'file') continue;
      const parts = node.path.split('/');
      const key = parts.length > 2 ? parts.slice(0, 2).join('/') : parts[0];
      if (!map.has(key)) map.set(key, { id: 'c:' + key, label: key, nodeIds: [], loc: 0 });
      map.get(key).nodeIds.push(id);
      map.get(key).loc += node.loc || 0;
    }
    return [...map.values()].sort((a, b) => b.loc - a.loc);
  }

  // seeded 3D force-directed layout (grid-accelerated repulsion)
  layout(maxNodes = 1500, iterations) {
    const n = this.nodes.size;
    if (!iterations) iterations = n > 2000 ? 40 : n > 800 ? 70 : 140;
    const nodes = [...this.nodes.values()];
    const fileNodes = nodes.filter((n) => n.kind === 'file');
    const useClusters = fileNodes.length > maxNodes;
    const clusters = useClusters ? this.clusters().filter((c) => c.nodeIds.length > 1) : [];
    const clusterOf = new Map();
    for (const c of clusters) for (const id of c.nodeIds) clusterOf.set(id, c);

    const ids = nodes.map((n) => n.id);
    const pos = new Map();
    const rnd = mulberry32(1337);
    const R = Math.cbrt(ids.length) * 60 + 40;
    ids.forEach((id, i) => {
      // fibonacci sphere
      const phi = Math.acos(1 - 2 * (i + 0.5) / ids.length);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      pos.set(id, {
        x: R * Math.sin(phi) * Math.cos(theta) + rnd() * 4,
        y: R * Math.sin(phi) * Math.sin(theta) + rnd() * 4,
        z: R * Math.cos(phi) + rnd() * 4,
      });
    });

    const edges = this.edges.filter((e) => e.kind === 'import' || e.kind === 'extends' || e.kind === 'call');
    const repulse = 2600;
    const spring = 0.035;
    const springLen = 55;

    for (let it = 0; it < iterations; it++) {
      const t = it / iterations;
      const cell = 90;
      const grid = new Map();
      for (const id of ids) {
        const p = pos.get(id);
        const key = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)},${Math.floor(p.z / cell)}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(id);
      }
      const force = new Map(ids.map((id) => [id, { x: 0, y: 0, z: 0 }]));
      for (const id of ids) {
        const p = pos.get(id);
        const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell), cz = Math.floor(p.z / cell);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          const cellIds = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!cellIds) continue;
          for (const other of cellIds) {
            if (other === id) continue;
            const q = pos.get(other);
            let ddx = p.x - q.x, ddy = p.y - q.y, ddz = p.z - q.z;
            let d2 = ddx * ddx + ddy * ddy + ddz * ddz + 0.01;
            const d = Math.sqrt(d2);
            const f = repulse / d2;
            const fscale = Math.min(f, 30);
            const fx = (ddx / d) * fscale, fy = (ddy / d) * fscale, fz = (ddz / d) * fscale;
            force.get(id).x += fx; force.get(id).y += fy; force.get(id).z += fz;
          }
        }
      }
      for (const e of edges) {
        const a = pos.get(e.from), b = pos.get(e.to);
        if (!a || !b) continue;
        let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01;
        const f = (d - springLen) * spring * (e.kind === 'import' || e.kind === 'extends' ? 1 : 0.4);
        dx = (dx / d) * f; dy = (dy / d) * f; dz = (dz / d) * f;
        force.get(e.from).x += dx; force.get(e.from).y += dy; force.get(e.from).z += dz;
        force.get(e.to).x -= dx; force.get(e.to).y -= dy; force.get(e.to).z -= dz;
      }
      const centering = 0.012 * (1 - t);
      for (const id of ids) {
        const p = pos.get(id);
        const f = force.get(id);
        f.x -= p.x * centering; f.y -= p.y * centering; f.z -= p.z * centering;
        const cap = 26;
        f.x = Math.max(-cap, Math.min(cap, f.x));
        f.y = Math.max(-cap, Math.min(cap, f.y));
        f.z = Math.max(-cap, Math.min(cap, f.z));
        p.x += f.x; p.y += f.y; p.z += f.z;
      }
    }

    // if clustered, pull cluster members into a small ball around centroid
    if (useClusters) {
      for (const c of clusters) {
        const members = c.nodeIds.map((id) => pos.get(id)).filter(Boolean);
        if (!members.length) continue;
        const cx = members.reduce((a, p) => a + p.x, 0) / members.length;
        const cy = members.reduce((a, p) => a + p.y, 0) / members.length;
        const cz = members.reduce((a, p) => a + p.z, 0) / members.length;
        members.forEach((p, i) => {
          const a = (i / members.length) * Math.PI * 2;
          const r = 6 + (i % 5);
          p.x = cx + Math.cos(a) * r;
          p.y = cy + Math.sin(a) * r * 0.6 + ((i % 3) - 1) * 2;
          p.z = cz + Math.sin(a * 1.3) * r * 0.5;
        });
      }
    }

    for (const [id, p] of pos) {
      const node = this.nodes.get(id);
      if (node) node.position = { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) };
    }
    this.clustersList = clusters;
    return this;
  }

  toJSON({ includePositions = true } = {}) {
    const nodes = [...this.nodes.values()].map((n) => {
      const { _facts, ...rest } = n;
      if (!includePositions && rest.position) rest.position = undefined;
      return rest;
    });
    return {
      nodes,
      edges: this.edges.map((e) => ({ ...e })),
      clusters: this.clustersList || this.clusters(),
      routes: this.allRoutes || [],
      unresolved: this.unresolved || [],
    };
  }
}
