// Builds a symbol-level graph (files + symbols as nodes) from a scan result.
export function buildSymbolGraph(result, maxSymbolNodes = 5000) {
  const g = result.graph;
  const nodes = [];
  const edges = [];
  const symbolNodeId = new Map();

  for (const [id, n] of g.nodes) {
    nodes.push({ ...n, position: n.position ? { ...n.position } : undefined });
  }
  // add symbol nodes (cap by importance: files with many symbols first by degree)
  const fileNodes = [...g.nodes.values()].filter((n) => n.kind === 'file' && !n.skipped)
    .sort((a, b) => (b.metrics.degree || 0) - (a.metrics.degree || 0));
  let count = 0;
  for (const fn of fileNodes) {
    if (count >= maxSymbolNodes) break;
    const facts = result.files.get(fn.path);
    if (!facts) continue;
    for (const s of facts.symbols || []) {
      if (count >= maxSymbolNodes) break;
      if (!['function', 'class', 'method', 'component', 'interface', 'type'].includes(s.kind)) continue;
      const sid = fn.path + '#' + s.name + ':' + s.line;
      symbolNodeId.set(fn.path + '|' + s.name, sid);
      const p = fn.position || { x: 0, y: 0, z: 0 };
      nodes.push({
        id: sid, label: s.name, path: fn.path, kind: 'symbol', symbolKind: s.kind,
        category: fn.category, lang: fn.lang, line: s.line, endLine: s.endLine,
        signature: s.signature, complexity: s.complexity,
        position: { x: p.x + (hash01(s.name) - 0.5) * 8, y: p.y + (hash01(s.line + s.name) - 0.5) * 8, z: p.z + (hash01(s.name + s.line) - 0.5) * 8 },
        metrics: { imports: 0, complexity: s.complexity || 0 }, risk: [],
      });
      edges.push({ id: 'se' + edges.length, from: fn.path, to: sid, kind: 'contains', confidence: 'certain', weight: 1 });
      count++;
    }
  }
  for (const e of g.edges) {
    if (e.kind === 'import' || e.kind === 'extends' || e.kind === 'dependency') {
      edges.push({ ...e });
    } else if (e.kind === 'call' && e.detail) {
      // attach call edge to symbol node if it exists
      const target = [...g.nodes.values()].find(() => false); // noop
      edges.push({ ...e });
    } else {
      edges.push({ ...e });
    }
  }
  // route → handler symbol edges
  for (const r of g.allRoutes || []) {
    if (r.handler) {
      const facts = result.files.get(r.file);
      const sym = facts?.symbols?.find((s) => s.name === r.handler);
      if (sym) {
        const sid = symbolNodeId.get(r.file + '|' + r.handler);
        if (sid) edges.push({ id: 'se' + edges.length, from: r.file, to: sid, kind: 'route-handler', confidence: 'certain', weight: 1, detail: `${r.method} ${r.path}` });
      }
    }
  }
  return { nodes, edges, clusters: g.clustersList || [], routes: g.allRoutes || [] };
}

function hash01(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000;
}
