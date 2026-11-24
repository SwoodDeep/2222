import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { nodeColor, on } from '../state.js';

const EDGE_COLORS = {
  import: 0x3d6b99, dependency: 0x8b949e, call: 0x2f4a5f, extends: 0xc792ea,
  http: 0xd29922, websocket: 0xff7b72, db: 0x82aaff, route: 0xc792ea, contains: 0x30363d,
};

export class BrainView {
  constructor(container, { onSelect, onHover } = {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x0b0e14, 0.0016);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 4000);
    this.camera.position.set(0, 60, 190);
    this.cam2d = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 4000);
    this.cam2d.position.set(0, 0, 300);
    this.is2d = false;
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 10;
    this.controls.maxDistance = 900;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.35;
    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.clock = new THREE.Clock();
    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Points.threshold = 2.2;
    this.pointer = new THREE.Vector2();
    this.nodeList = [];
    this.nodeById = new Map();
    this.clusterMode = false;
    this.clusterThreshold = 2200;
    this.timeUniform = { value: 0 };
    this.selectedId = null;
    this.chainSet = new Set();
    this._bindPointer();
    this._resize = () => this.resize();
    addEventListener('resize', this._resize);
    this.resize();
    this._animate();
  }

  resize() {
    const w = this.container.clientWidth || 2, h = this.container.clientHeight || 2;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const d = 300;
    this.cam2d.left = -d * w / h / 2; this.cam2d.right = d * w / h / 2;
    this.cam2d.top = d / 2; this.cam2d.bottom = -d / 2;
    this.cam2d.updateProjectionMatrix();
  }

  setGraph(graph, { hiddenCategories = new Set(), clusterMode = null } = {}) {
    this.graph = graph;
    this.hiddenCategories = hiddenCategories;
    if (clusterMode !== null) this.clusterMode = clusterMode;
    this.rebuild();
  }

  visibleNodes() {
    if (!this.graph) return [];
    return this.graph.nodes.filter((n) => !this.hiddenCategories.has(n.category) && !n.skipped);
  }

  aggregated() {
    const nodes = this.visibleNodes();
    if (!this.clusterMode && nodes.length <= this.clusterThreshold) return null;
    const clusters = (this.graph.clusters || []).filter((c) => c.nodeIds?.length > 1);
    if (!clusters.length) return null;
    const inCluster = new Set();
    for (const c of clusters) for (const id of c.nodeIds) inCluster.add(id);
    const superNodes = clusters.map((c) => {
      const members = c.nodeIds.map((id) => this.graph.nodes.find((n) => n.id === id)).filter((n) => n && !this.hiddenCategories.has(n.category));
      const centroid = members.reduce((a, n) => ({ x: a.x + (n.position?.x || 0), y: a.y + (n.position?.y || 0), z: a.z + (n.position?.z || 0) }), { x: 0, y: 0, z: 0 });
      const k = Math.max(1, members.length);
      return {
        id: c.id, label: c.label, kind: 'cluster', category: 'virtual',
        position: { x: centroid.x / k, y: centroid.y / k, z: centroid.z / k },
        loc: c.loc, count: members.length, memberIds: members.map((m) => m.id),
        metrics: { importance: members.reduce((a, m) => a + (m.metrics?.importance || 0), 0) },
        risk: [],
      };
    });
    const loose = nodes.filter((n) => !inCluster.has(n.id));
    const all = [...superNodes, ...loose];
    const superEdges = [];
    const seen = new Set();
    const clusterOf = new Map();
    for (const c of clusters) for (const id of c.nodeIds) clusterOf.set(id, c.id);
    for (const e of this.graph.edges) {
      if (this.hiddenCategories.has(this.graph.nodes.find((n) => n.id === e.from)?.category)) continue;
      const f = clusterOf.get(e.from) || e.from;
      const t = clusterOf.get(e.to) || e.to;
      if (f === t) continue;
      const key = f + '|' + t + '|' + e.kind;
      if (seen.has(key)) continue;
      seen.add(key);
      superEdges.push({ from: f, to: t, kind: e.kind, confidence: e.confidence });
    }
    return { nodes: all, edges: superEdges };
  }

  rebuild() {
    // clear
    while (this.world.children.length) {
      const c = this.world.children.pop();
      c.geometry?.dispose?.();
      (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => m.dispose?.());
      this.world.remove(c);
    }
    this.labels?.forEach((s) => this.scene.remove(s));
    this.labels = [];
    this.nodeList = [];
    this.nodeById = new Map();
    const data = this.aggregated() || { nodes: this.visibleNodes(), edges: this.graph.edges.filter((e) => {
      const f = this.graph.nodes.find((n) => n.id === e.from);
      const t = this.graph.nodes.find((n) => n.id === e.to);
      return f && t && !this.hiddenCategories.has(f.category) && !this.hiddenCategories.has(t.category);
    }) };
    this.display = data;
    const nodes = data.nodes;
    if (!nodes.length) return;

    // normalize positions to radius ~60
    let maxR = 1;
    for (const n of nodes) { const p = n.position || { x: 0, y: 0, z: 0 }; maxR = Math.max(maxR, Math.hypot(p.x, p.y, p.z)); }
    const scale = 60 / maxR;
    const pos = new Float32Array(nodes.length * 3);
    const col = new Float32Array(nodes.length * 3);
    const size = new Float32Array(nodes.length);
    const phase = new Float32Array(nodes.length);
    nodes.forEach((n, i) => {
      const p = n.position || { x: 0, y: 0, z: 0 };
      pos[i * 3] = p.x * scale; pos[i * 3 + 1] = p.y * scale; pos[i * 3 + 2] = p.z * scale;
      const c = new THREE.Color(n.kind === 'cluster' ? '#58a6ff' : nodeColor(n));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      const base = n.kind === 'cluster' ? 6 + Math.min(14, Math.cbrt(n.count) * 3) : 1.6 + Math.min(7, (n.metrics?.importance || 0) / 9);
      size[i] = base;
      phase[i] = (i * 0.61803) % 1;
      this.nodeById.set(n.id, { node: n, index: i });
      this.nodeList.push({ node: n, index: i });
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.setAttribute('aDim', new THREE.BufferAttribute(new Float32Array(nodes.length), 1));
    geo.setAttribute('aHi', new THREE.BufferAttribute(new Float32Array(nodes.length), 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: this.timeUniform, uPx: { value: Math.min(devicePixelRatio, 2) } },
      vertexShader: `
        attribute vec3 aColor; attribute float aSize; attribute float aPhase; attribute float aDim; attribute float aHi;
        uniform float uTime; uniform float uPx;
        varying vec3 vColor; varying float vHi; varying float vDim;
        void main() {
          vColor = aColor; vHi = aHi; vDim = aDim;
          vec3 p = position;
          float breathe = 1.0 + 0.10 * sin(uTime * 1.6 + aPhase * 6.2831);
          float sz = aSize * breathe * (1.0 + aHi * 1.6) * (1.0 - aDim * 0.75);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = sz * uPx * (160.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColor; varying float vHi; varying float vDim;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.05, d);
          vec3 c = vColor * (1.0 + vHi * 1.8);
          gl_FragColor = vec4(c, a * (1.0 - vDim * 0.85));
        }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.userData.isNodes = true;
    this.world.add(this.points);

    // edges
    const epos = [];
    const ecol = [];
    const edgeIndex = [];
    data.edges.forEach((e, i) => {
      const a = this.nodeById.get(e.from), b = this.nodeById.get(e.to);
      if (!a || !b) return;
      epos.push(pos[a.index * 3], pos[a.index * 3 + 1], pos[a.index * 3 + 2], pos[b.index * 3], pos[b.index * 3 + 1], pos[b.index * 3 + 2]);
      const c = new THREE.Color(EDGE_COLORS[e.kind] || 0x3d6b99);
      const conf = e.confidence === 'certain' ? 1 : 0.45;
      ecol.push(c.r * conf, c.g * conf, c.b * conf, c.r * conf, c.g * conf, c.b * conf);
      edgeIndex.push(i);
    });
    const egeo = new THREE.BufferGeometry();
    egeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(epos), 3));
    egeo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(ecol), 3));
    egeo.setAttribute('aHi', new THREE.BufferAttribute(new Float32Array(epos.length / 3), 1));
    const edgeMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: this.timeUniform },
      vertexShader: `
        attribute vec3 aColor; attribute float aHi;
        varying vec3 vColor; varying float vHi;
        void main(){ vColor = aColor * (1.0 + aHi * 2.5); vHi = aHi;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        varying vec3 vColor; varying float vHi;
        void main(){ gl_FragColor = vec4(vColor, 0.16 + vHi * 0.65); }`,
    });
    this.edgesObj = new THREE.LineSegments(egeo, edgeMat);
    this.world.add(this.edgesObj);
    this.edgeIndex = edgeIndex;

    // pulses along edges
    const pulsesPerEdge = 1;
    const maxPulses = Math.min(data.edges.length * pulsesPerEdge, 5000);
    const pFrom = new Float32Array(maxPulses * 3);
    const pTo = new Float32Array(maxPulses * 3);
    const pSpeed = new Float32Array(maxPulses);
    const pPhase = new Float32Array(maxPulses);
    const pColor = new Float32Array(maxPulses * 3);
    let pi = 0;
    for (let i = 0; i < data.edges.length && pi < maxPulses; i++) {
      const e = data.edges[i];
      const a = this.nodeById.get(e.from), b = this.nodeById.get(e.to);
      if (!a || !b) continue;
      pFrom.set([pos[a.index * 3], pos[a.index * 3 + 1], pos[a.index * 3 + 2]], pi * 3);
      pTo.set([pos[b.index * 3], pos[b.index * 3 + 1], pos[b.index * 3 + 2]], pi * 3);
      pSpeed[pi] = 0.05 + ((i * 0.37) % 1) * 0.12;
      pPhase[pi] = (i * 0.6180339) % 1;
      const c = new THREE.Color(EDGE_COLORS[e.kind] || 0x58a6ff).multiplyScalar(1.6);
      pColor.set([c.r, c.g, c.b], pi * 3);
      pi++;
    }
    const pgeo = new THREE.BufferGeometry();
    pgeo.setAttribute('aFrom', new THREE.BufferAttribute(pFrom.slice(0, pi * 3), 3));
    pgeo.setAttribute('aTo', new THREE.BufferAttribute(pTo.slice(0, pi * 3), 3));
    pgeo.setAttribute('aSpeed', new THREE.BufferAttribute(pSpeed.slice(0, pi), 1));
    pgeo.setAttribute('aPhase', new THREE.BufferAttribute(pPhase.slice(0, pi), 1));
    pgeo.setAttribute('aColor', new THREE.BufferAttribute(pColor.slice(0, pi * 3), 3));
    const pmat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: this.timeUniform, uPx: { value: Math.min(devicePixelRatio, 2) } },
      vertexShader: `
        attribute vec3 aFrom; attribute vec3 aTo; attribute float aSpeed; attribute float aPhase; attribute vec3 aColor;
        uniform float uTime; uniform float uPx;
        varying vec3 vColor;
        void main(){
          vColor = aColor;
          float t = fract(uTime * aSpeed + aPhase);
          vec3 p = mix(aFrom, aTo, t);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = 2.6 * uPx * (160.0 / -mv.z) * smoothstep(0.0, 0.15, t) * smoothstep(1.0, 0.85, t) + 0.5;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColor;
        void main(){ vec2 uv = gl_PointCoord - 0.5; float d = length(uv); if (d > 0.5) discard;
          gl_FragColor = vec4(vColor, smoothstep(0.5, 0.0, d) * 0.9); }`,
    });
    this.pulses = new THREE.Points(pgeo, pmat);
    this.world.add(this.pulses);

    // cluster labels (top clusters)
    if (data.nodes.some((n) => n.kind === 'cluster')) {
      const clusters = data.nodes.filter((n) => n.kind === 'cluster').sort((a, b) => (b.loc || 0) - (a.loc || 0)).slice(0, 14);
      for (const c of clusters) {
        const p = c.position;
        const sprite = makeLabel(c.label, c.count);
        sprite.position.set(p.x * scale, p.y * scale, p.z * scale);
        this.scene.add(sprite);
        this.labels.push(sprite);
      }
    }
    this.applySelection();
  }

  computeChain(id) {
    // outgoing dependency chain (import/extends/call/http) up to depth 6
    const set = new Set([id]);
    if (!this.display) return set;
    const adj = new Map();
    for (const e of this.display.edges) {
      if (!['import', 'extends', 'call', 'http'].includes(e.kind)) continue;
      if (!adj.has(e.from)) adj.set(e.from, []);
      adj.get(e.from).push(e.to);
    }
    const q = [[id, 0]];
    while (q.length) {
      const [cur, d] = q.shift();
      if (d >= 6) continue;
      for (const nxt of adj.get(cur) || []) {
        if (!set.has(nxt)) { set.add(nxt); q.push([nxt, d + 1]); }
      }
    }
    return set;
  }

  select(id) {
    this.selectedId = id;
    this.chainSet = id ? this.computeChain(id) : new Set();
    this.applySelection();
  }

  applySelection() {
    if (!this.points) return;
    const dim = this.points.geometry.getAttribute('aDim');
    const hi = this.points.geometry.getAttribute('aHi');
    const hasSel = !!this.selectedId;
    for (const { index } of this.nodeList) {
      const id = this.nodeList[index].node.id;
      hi.setX(index, id === this.selectedId ? 1 : 0);
      dim.setX(index, hasSel && !this.chainSet.has(id) && id !== this.selectedId ? 1 : 0);
    }
    hi.needsUpdate = true; dim.needsUpdate = true;
    if (this.edgesObj) {
      const ehi = this.edgesObj.geometry.getAttribute('aHi');
      this.display.edges.forEach((e, i) => {
        const inChain = hasSel && this.chainSet.has(e.from) && this.chainSet.has(e.to);
        ehi.setX(i, inChain ? 1 : 0);
      });
      ehi.needsUpdate = true;
    }
  }

  toggle2D() {
    this.is2d = !this.is2d;
    if (this.is2d) {
      this.controls.enabled = false;
      this.camera2d = this.cam2d;
    } else {
      this.controls.enabled = true;
      this.camera2d = null;
    }
    return this.is2d;
  }

  activeCamera() { return this.is2d ? this.cam2d : this.camera; }

  fit() {
    if (!this.nodeList.length) return;
    const box = new THREE.Box3();
    for (const { node } of this.nodeList) {
      const p = node.position || { x: 0, y: 0, z: 0 };
      box.expandByPoint(new THREE.Vector3(p.x, p.y, p.z));
    }
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(10, box.getSize(new THREE.Vector3()).length() / 2);
    if (this.is2d) {
      this.cam2d.position.set(c.x, c.y, 300);
      const d = r * 1.15;
      const w = this.container.clientWidth, h = this.container.clientHeight;
      this.cam2d.left = -d * w / h / 2; this.cam2d.right = d * w / h / 2;
      this.cam2d.top = d / 2; this.cam2d.bottom = -d / 2;
      this.cam2d.updateProjectionMatrix();
    } else {
      this.camera.position.set(c.x, c.y + r * 0.4, c.z + r * 1.6);
      this.controls.target.copy(c);
      this.controls.update();
    }
  }

  _bindPointer() {
    const el = this.renderer.domElement;
    let downAt = 0;
    el.addEventListener('pointerdown', () => { downAt = performance.now(); });
    el.addEventListener('pointerup', (ev) => {
      if (performance.now() - downAt > 250) return; // drag, not click
      const rect = el.getBoundingClientRect();
      this.pointer.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      this.raycaster.setFromCamera(this.pointer, this.activeCamera());
      if (!this.points) return;
      const hits = this.raycaster.intersectObject(this.points);
      if (hits.length) {
        const idx = hits[0].index;
        const n = this.nodeList[idx]?.node;
        if (n) this.onSelect?.(n.id, n);
      } else {
        this.onSelect?.(null, null);
      }
    });
    el.addEventListener('pointermove', (ev) => {
      if (!this.onHover) return;
      const rect = el.getBoundingClientRect();
      this.pointer.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      this.raycaster.setFromCamera(this.pointer, this.activeCamera());
      if (!this.points) return;
      const hits = this.raycaster.intersectObject(this.points);
      if (hits.length) {
        const n = this.nodeList[hits[0].index]?.node;
        if (n) this.onHover(n, ev.clientX - rect.left, ev.clientY - rect.top);
      } else this.onHover(null);
    });
    // 2D pan
    el.addEventListener('wheel', (ev) => {
      if (!this.is2d) return;
      ev.preventDefault();
      const f = ev.deltaY > 0 ? 1.12 : 0.89;
      this.cam2d.left *= f; this.cam2d.right *= f; this.cam2d.top *= f; this.cam2d.bottom *= f;
      this.cam2d.updateProjectionMatrix();
    }, { passive: false });
    let panning = false, last = null;
    el.addEventListener('pointerdown', (ev) => { if (this.is2d) { panning = true; last = [ev.clientX, ev.clientY]; } });
    addEventListener('pointerup', () => { panning = false; });
    el.addEventListener('pointermove', (ev) => {
      if (!this.is2d || !panning || !last) return;
      const dx = ev.clientX - last[0], dy = ev.clientY - last[1];
      last = [ev.clientX, ev.clientY];
      const w = this.container.clientWidth, h = this.container.clientHeight;
      const worldPerPixel = (this.cam2d.right - this.cam2d.left) / w;
      this.cam2d.left -= dx * worldPerPixel; this.cam2d.right -= dx * worldPerPixel;
      this.cam2d.top += dy * worldPerPixel; this.cam2d.bottom += dy * worldPerPixel;
      this.cam2d.updateProjectionMatrix();
    });
  }

  _animate() {
    requestAnimationFrame(() => this._animate());
    const t = this.clock.getElapsedTime();
    this.timeUniform.value = t;
    if (!this.is2d) this.controls.update();
    this.renderer.render(this.scene, this.activeCamera());
  }

  dispose() {
    removeEventListener('resize', this._resize);
    this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);
  }
}

function makeLabel(text, count) {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 96;
  const ctx = cv.getContext('2d');
  ctx.font = '26px ui-monospace, monospace';
  ctx.fillStyle = 'rgba(88,166,255,0.95)';
  ctx.textAlign = 'center';
  ctx.fillText(`${text}  (${count})`, 256, 58);
  const tex = new THREE.CanvasTexture(cv);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(46, 8.6, 1);
  return sp;
}
