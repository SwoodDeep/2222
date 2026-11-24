import { nodeColor, CATEGORY_COLORS, KIND_LABELS } from '../state.js';

const EDGE_COLORS = {
  import: '#3d6b99', dependency: '#8b949e', call: '#2f4a5f', extends: '#c792ea',
  http: '#d29922', websocket: '#ff7b72', db: '#82aaff', route: '#c792ea', contains: '#30363d',
};

const LAYER_ORDER = ['frontend', 'api', 'backend', 'service', 'database', 'config', 'test', 'docs', 'external', 'virtual', 'other'];

export class CanvasView {
  constructor(container, mode, { onSelect, onHover } = {}) {
    this.container = container;
    this.mode = mode;
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'width:100%;height:100%;display:block;cursor:grab';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.cam = { x: 0, y: 0, z: 1 };
    this.selectedId = null;
    this.impactSet = null;
    this._bind();
    this._resize = () => this.resize();
    addEventListener('resize', this._resize);
    this.resize();
  }

  resize() {
    const dpr = Math.min(devicePixelRatio, 2);
    const w = this.container.clientWidth || 2, h = this.container.clientHeight || 2;
    this.canvas.width = w * dpr; this.canvas.height = h * dpr;
    this.dpr = dpr; this.w = w; this.h = h;
    this.draw();
  }

  setGraph(graph, { hiddenCategories = new Set(), impact = null } = {}) {
    this.graph = graph;
    this.hiddenCategories = hiddenCategories;
    this.impactSet = impact ? new Set(impact.impacted.concat([impact.start])) : null;
    this.layout();
    this.draw();
  }

  nodes() {
    if (!this.graph) return [];
    return this.graph.nodes.filter((n) => !n.skipped && !this.hiddenCategories?.has(n.category));
  }

  edges() {
    if (!this.graph) return [];
    const ns = this.graph.nodes;
    const byId = new Map(ns.map((n) => [n.id, n]));
    return this.graph.edges.filter((e) => {
      const f = byId.get(e.from), t = byId.get(e.to);
      if (!f || !t) return false;
      if (this.hiddenCategories?.has(f.category) || this.hiddenCategories?.has(t.category)) return false;
      if (this.mode === 'dataflow' && !['http', 'websocket', 'db', 'route'].includes(e.kind)) return false;
      if (this.mode === 'apimap' && !['http', 'websocket'].includes(e.kind)) return false;
      if (this.mode === 'riskmap' && !((f.risk?.length) || (t.risk?.length))) return false;
      if (this.mode === 'impact' && this.impactSet && !(this.impactSet.has(e.from) && this.impactSet.has(e.to))) return false;
      return true;
    });
  }

  layout() {
    const nodes = this.nodes();
    const pos = new Map();
    if (this.mode === 'architecture') {
      const byLayer = new Map();
      for (const n of nodes) {
        const li = LAYER_ORDER.indexOf(n.category);
        const layer = li >= 0 ? li : LAYER_ORDER.length - 1;
        if (!byLayer.has(layer)) byLayer.set(layer, []);
        byLayer.get(layer).push(n);
      }
      const layerH = 130, xGap = 90;
      for (const [layer, list] of byLayer) {
        list.sort((a, b) => (b.metrics?.importance || 0) - (a.metrics?.importance || 0));
        const y = layer * layerH;
        const w = (list.length - 1) * xGap;
        list.forEach((n, i) => pos.set(n.id, { x: i * xGap - w / 2, y, label: LAYER_ORDER[layer] }));
      }
    } else if (this.mode === 'apimap') {
      const routes = new Set((this.graph.routes || []).map((r) => r.file));
      const edges = this.edges();
      const clients = new Set(), servers = new Set();
      for (const e of edges) { clients.add(e.from); servers.add(e.to); }
      for (const r of this.graph.routes || []) servers.add(r.file);
      const all = nodes.filter((n) => clients.has(n.id) || servers.has(n.id) || routes.has(n.id));
      const cl = all.filter((n) => clients.has(n.id));
      const sv = all.filter((n) => !clients.has(n.id));
      cl.forEach((n, i) => pos.set(n.id, { x: -320, y: i * 46 - cl.length * 23 }));
      sv.forEach((n, i) => pos.set(n.id, { x: 320, y: i * 46 - sv.length * 23 }));
      // include remaining nodes loosely on sides
      for (const n of all) if (!pos.has(n.id)) pos.set(n.id, { x: 0, y: 0 });
    } else {
      for (const n of nodes) {
        const p = n.position || { x: 0, y: 0 };
        pos.set(n.id, { x: p.x, y: -p.y }); // flip y for screen
      }
    }
    // normalize to fit
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (const p of pos.values()) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    const W = Math.max(1, maxX - minX), H = Math.max(1, maxY - minY);
    const s = Math.min(this.w / (W + 80), this.h / (H + 80));
    for (const p of pos.values()) { p.x = (p.x - minX) * s + 40; p.y = (p.y - minY) * s + 40; }
    this.pos = pos;
    this.baseScale = s;
  }

  toScreen(p) {
    return { x: (p.x + this.cam.x) * this.cam.z + this.w / 2, y: (p.y + this.cam.y) * this.cam.z + this.h / 2 };
  }
  toWorld(x, y) {
    return { x: (x - this.w / 2) / this.cam.z - this.cam.x, y: (y - this.h / 2) / this.cam.z - this.cam.y };
  }

  draw() {
    const { ctx, w, h, dpr } = this;
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(0, 0, w, h);
    if (!this.graph || !this.pos) return;
    const nodes = this.nodes();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges = this.edges();

    // edges
    for (const e of edges) {
      const a = this.pos.get(e.from), b = this.pos.get(e.to);
      if (!a || !b) continue;
      const sa = this.toScreen(a), sb = this.toScreen(b);
      const inImpact = this.mode === 'impact' && this.impactSet;
      const hot = inImpact && this.impactSet.has(e.from) && this.impactSet.has(e.to);
      ctx.strokeStyle = hot ? '#ffd76d' : (EDGE_COLORS[e.kind] || '#3d6b99');
      ctx.globalAlpha = e.confidence === 'inferred' ? 0.35 : (hot ? 0.95 : 0.55);
      ctx.setLineDash(e.confidence === 'inferred' ? [4, 4] : []);
      ctx.lineWidth = hot ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke();
      // arrowhead
      const ang = Math.atan2(sb.y - sa.y, sb.x - sa.x);
      const r = 4 + (byId.get(e.to)?.metrics?.importance || 0) / 30;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(sb.x, sb.y);
      ctx.lineTo(sb.x - r * Math.cos(ang - 0.4), sb.y - r * Math.sin(ang - 0.4));
      ctx.lineTo(sb.x - r * Math.cos(ang + 0.4), sb.y - r * Math.sin(ang + 0.4));
      ctx.closePath(); ctx.fillStyle = ctx.strokeStyle; ctx.fill();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // nodes
    for (const n of nodes) {
      const p = this.pos.get(n.id);
      if (!p) continue;
      const s = this.toScreen(p);
      const r = Math.max(2.5, (1.6 + Math.min(7, (n.metrics?.importance || 0) / 9)) * this.cam.z * (this.mode === 'architecture' ? 1.4 : 1));
      let color = nodeColor(n);
      if (this.mode === 'apimap') {
        const hasRoutes = (this.graph.routes || []).some((rt) => rt.file === n.id);
        color = hasRoutes ? '#c792ea' : (n.networkOut ? '#4cc2ff' : nodeColor(n));
      }
      if (this.mode === 'impact' && this.impactSet) {
        if (!this.impactSet.has(n.id)) ctx.globalAlpha = 0.12;
        else if (n.id === this.selectedId) color = '#ffd76d';
      }
      if (this.mode === 'riskmap') {
        const sev = n.risk?.includes('secret') || n.risk?.includes('cycle') ? 3 : n.risk?.length >= 2 ? 2 : 1;
        color = ['#f85149', '#f85149', '#f0883e', '#d29922'][sev] || '#d29922';
      }
      ctx.beginPath();
      ctx.arc(s.x, s.y, n.id === this.selectedId ? r + 3 : r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.shadowColor = color; ctx.shadowBlur = n.id === this.selectedId ? 18 : 6;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
      if (this.cam.z > 0.9 && nodes.length < 400) {
        ctx.fillStyle = '#c9d1d9';
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillText(n.label, s.x + r + 3, s.y + 3);
      }
    }
  }

  select(id) { this.selectedId = id; this.draw(); }

  fit() {
    this.cam = { x: 0, y: 0, z: 1 };
    this.draw();
  }

  _bind() {
    let drag = null, downAt = 0, moved = false;
    this.canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, cam: { ...this.cam } }; downAt = performance.now(); moved = false; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener('pointermove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
        this.cam.x = drag.cam.x + dx / this.cam.z;
        this.cam.y = drag.cam.y + dy / this.cam.z;
        this.draw();
      } else if (this.onHover) {
        const hit = this.pick(mx, my);
        this.onHover(hit ? hit.node : null, mx, my);
      }
    });
    this.canvas.addEventListener('pointerup', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (!moved && performance.now() - downAt < 400) {
        const hit = this.pick(mx, my);
        this.onSelect?.(hit ? hit.node.id : null, hit ? hit.node : null);
      }
      drag = null;
    });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const f = e.deltaY > 0 ? 0.88 : 1.14;
      const z2 = Math.max(0.15, Math.min(6, this.cam.z * f));
      const wpt = this.toWorld(mx, my);
      this.cam.z = z2;
      const s = this.toScreen(wpt);
      this.cam.x += (mx - s.x) / z2;
      this.cam.y += (my - s.y) / z2;
      this.draw();
    }, { passive: false });
  }

  pick(mx, my) {
    if (!this.pos) return null;
    let best = null, bestD = 14;
    for (const n of this.nodes()) {
      const p = this.pos.get(n.id);
      if (!p) continue;
      const s = this.toScreen(p);
      const d = Math.hypot(s.x - mx, s.y - my);
      const r = Math.max(6, (1.6 + Math.min(7, (n.metrics?.importance || 0) / 9)) * this.cam.z);
      if (d < Math.max(bestD, r)) { best = { node: n }; bestD = d; }
    }
    return best;
  }

  dispose() {
    removeEventListener('resize', this._resize);
    this.canvas.remove();
  }
}
