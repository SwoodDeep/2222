import { api } from './api.js';
import { state, on, emit, saveSettings, CATEGORY_COLORS, CATEGORY_LABELS } from './state.js';
import { FileTree } from './tree.js';
import { Inspector } from './inspector.js';
import { BottomPanel } from './bottom.js';
import { BrainView } from './views/brain3d.js';
import { CanvasView } from './views/canvas2d.js';
import { FilesView } from './views/filesView.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const VIEWS = [
  { id: 'brain', label: 'Brain 3D' },
  { id: 'architecture', label: 'Архитектура' },
  { id: 'deps', label: 'Зависимости' },
  { id: 'dataflow', label: 'Data Flow' },
  { id: 'apimap', label: 'API Map' },
  { id: 'riskmap', label: 'Risk Map' },
  { id: 'files', label: 'Файлы' },
  { id: 'impact', label: 'Impact' },
];

let view = null;
let tree = null;
let inspector = null;
let bottom = null;
let events = null;

// ---------- boot ----------
init();

async function init() {
  applyLayout();
  bottom = new BottomPanel();
  tree = new FileTree($('#file-tree'), { onSelect: (p) => selectNode(p) });
  inspector = new Inspector($('#inspector'), {
    onSelect: (id) => selectNode(id),
    onShowCode: (id) => bottom.showCode(id),
    onImpact: (id) => { setView('impact'); selectNode(id); },
  });
  buildTabs();
  wireTopbar();
  wireResizers();
  wireHotkeys();
  wireSearch();
  wireAddProject();
  window.addEventListener('codebrain:select', (e) => selectNode(e.detail));
  await loadProjects();
  const lastId = localStorage.getItem('codebrain:lastProject');
  if (lastId) {
    const p = state.projects.find((x) => x.id === lastId);
    if (p) await selectProject(p.id, false);
  }
  bottom.log('CodeBrain готов. Добавьте папку проекта, чтобы начать анализ.', 'ok');
}

async function loadProjects() {
  try {
    state.projects = await api.listProjects();
  } catch (e) {
    bottom?.log('Ошибка загрузки проектов: ' + e.message, 'err');
    state.projects = [];
  }
  const sel = $('#project-select');
  sel.innerHTML = state.projects.length
    ? state.projects.map((p) => `<option value="${p.id}">${esc(p.name)} — ${esc(p.rootPath)}</option>`).join('')
    : '<option value="">— нет проектов —</option>';
  if (state.project) sel.value = state.project.id;
}

async function selectProject(id, scanIfNeeded = true) {
  const p = state.projects.find((x) => x.id === id);
  if (!p) return;
  state.project = p;
  localStorage.setItem('codebrain:lastProject', id);
  $('#project-select').value = id;
  connectEvents(p);
  let st;
  try { st = await api.status(id); } catch { st = null; }
  if (st?.hasResult) {
    await loadGraph();
  } else if (scanIfNeeded) {
    await startScan();
  } else {
    bottom.log(`Проект «${p.name}» добавлен. Нажмите «Сканировать».`, 'info');
    setView(state.view);
  }
}

function connectEvents(p) {
  events?.close?.();
  events = api.events(p.id, {
    'scan-start': () => { state.scanning = true; $('#btn-cancel').hidden = false; showProgress(0, 'Запуск сканирования…'); },
    progress: (d) => {
      state.scanning = true;
      const total = d.total || 0, done = d.done || 0;
      const pct = total ? Math.round((done / total) * 100) : 0;
      showProgress(d.phase === 'parsing' ? pct : 0, d.message || d.phase);
      if (d.phase !== 'parsing') bottom.log(d.message || d.phase, 'info');
    },
    graph: (d) => {
      state.scanning = false;
      $('#btn-cancel').hidden = true;
      hideProgress();
      bottom.log(`Анализ завершён: ${d.stats?.files ?? '?'} файлов, ${d.stats?.edges ?? '?'} связей, рисков: ${d.stats?.risks ?? 0}${d.incremental ? ' (инкрементально)' : ''}`, 'ok');
      loadGraph();
    },
    'scan-cancelled': () => { state.scanning = false; $('#btn-cancel').hidden = true; hideProgress(); bottom.log('Сканирование отменено', 'warn'); },
    'scan-error': (d) => { state.scanning = false; $('#btn-cancel').hidden = true; hideProgress(); bottom.log('Ошибка сканирования: ' + d.message, 'err'); },
    watch: (d) => bottom.log(d.message || 'Изменения в файлах', 'warn'),
  });
}

async function startScan() {
  if (!state.project) return bottom.log('Сначала выберите проект', 'warn');
  try {
    const r = await api.scan(state.project.id);
    if (r.ok) await loadGraph();
  } catch (e) {
    if (e.status === 409) bottom.log('Сканирование уже выполняется', 'warn');
    else bottom.log('Не удалось запустить сканирование: ' + e.message, 'err');
  }
}

async function loadGraph() {
  if (!state.project) return;
  try {
    const [graph, treeData] = await Promise.all([api.graph(state.project.id), api.tree(state.project.id)]);
    state.graph = graph;
    state.tree = treeData;
    tree.setData(treeData, graph.stats);
    $('#tree-stats').textContent = `${graph.stats.files} файлов · ${graph.stats.loc} строк · ${graph.stats.edges} связей · рисков: ${graph.stats.risks}`;
    buildCategoryFilters();
    renderView();
    if (state.selected) selectNode(state.selected);
    bottom.renderDiagnosticsIfOpen?.();
  } catch (e) {
    if (e.needScan) { bottom.log('Проект не просканирован. Нажмите «Сканировать».', 'warn'); }
    else bottom.log('Ошибка загрузки графа: ' + e.message, 'err');
  }
}

// ---------- views ----------
function buildTabs() {
  const nav = $('#view-tabs');
  nav.innerHTML = '';
  for (const v of VIEWS) {
    const b = document.createElement('button');
    b.textContent = v.label;
    b.dataset.view = v.id;
    b.classList.toggle('active', state.view === v.id);
    b.onclick = () => setView(v.id);
    nav.appendChild(b);
  }
}

function setView(id) {
  state.view = id;
  document.querySelectorAll('#view-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === id));
  renderView();
}

function renderView() {
  const vp = $('#viewport');
  vp.innerHTML = '';
  if (view) { try { view.dispose?.(); } catch {} view = null; }
  $('#view-title').textContent = (VIEWS.find((v) => v.id === state.view) || {}).label || '';
  const isBrain = state.view === 'brain';
  $('#btn-2d3d').style.display = isBrain ? '' : 'none';
  $('#btn-clusters').style.display = isBrain ? '' : 'none';
  if (!state.graph) {
    vp.innerHTML = '<div style="display:flex;height:100%;align-items:center;justify-content:center" class="muted">Нет данных — просканируйте проект</div>';
    return;
  }
  const opts = { hiddenCategories: state.hiddenCategories };
  const onSel = (id, n) => selectNode(id);
  const onHov = (n, x, y) => showTooltip(n, x, y);
  if (isBrain) {
    view = new BrainView(vp, { onSelect: onSel, onHover: onHov });
    view.setGraph(state.graph, opts);
    $('#graph-stats').textContent = `${state.graph.nodes.length} узлов · ${state.graph.edges.length} связей`;
    $('#btn-2d3d').textContent = view.is2d ? '3D' : '2D';
  } else if (state.view === 'files') {
    view = new FilesView(vp, { onSelect: onSel });
    view.setGraph(state.graph, state.tree);
    $('#graph-stats').textContent = `${state.graph.stats?.files ?? 0} файлов`;
  } else {
    view = new CanvasView(vp, state.view, { onSelect: onSel, onHover: onHov });
    const impact = state.view === 'impact' ? state.impact : null;
    view.setGraph(state.graph, { ...opts, impact });
    $('#graph-stats').textContent = `${view.nodes().length} узлов · ${view.edges().length} связей`;
  }
  if (state.view === 'impact' && !state.selected && state.graph?.stats?.hubs?.length) {
    selectNode(state.graph.stats.hubs[0].path);
    return;
  }
  if (state.selected) view.select?.(state.selected);
}

async function selectNode(id, center) {
  state.selected = id;
  if (!id) { inspector.render(null); return; }
  tree.select(id);
  inspector.render(id);
  view?.select?.(id);
  if (state.view === 'impact') {
    try {
      state.impact = await api.impact(state.project.id, id);
      if (view instanceof CanvasView) view.setGraph(state.graph, { hiddenCategories: state.hiddenCategories, impact: state.impact });
      bottom.log(`Impact: изменение «${id}» потенциально затрагивает ${state.impact.impactCount} компонентов`, 'info');
    } catch (e) { bottom.log('Impact: ' + e.message, 'err'); }
  }
}

function showTooltip(n, x, y) {
  const t = $('#tooltip');
  if (!n) { t.classList.add('hidden'); return; }
  t.innerHTML = `<b>${esc(n.label)}</b><br><span class="muted">${esc(n.path)}</span><br>
    <span style="color:${nodeColorOf(n)}">●</span> ${esc(CATEGORY_LABELS[n.category] || n.category)} · ${n.loc ?? 0} стр · связей: ${(n.metrics?.degree ?? 0)}
    ${n.risk?.length ? `<br><span style="color:#f0883e">риски: ${esc(n.risk.join(', '))}</span>` : ''}`;
  t.style.left = x + 14 + 'px';
  t.style.top = y + 14 + 'px';
  t.classList.remove('hidden');
}
function nodeColorOf(n) { return CATEGORY_COLORS[n.category] || '#adbac7'; }

// ---------- category filters ----------
function buildCategoryFilters() {
  const host = $('#category-filters');
  host.innerHTML = '';
  if (!state.graph) return;
  const counts = {};
  for (const n of state.graph.nodes) counts[n.category] = (counts[n.category] || 0) + 1;
  for (const [cat, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    const l = document.createElement('label');
    const on = !state.hiddenCategories.has(cat);
    l.className = on ? 'on' : '';
    l.innerHTML = `<span class="dot" style="background:${CATEGORY_COLORS[cat] || '#888'}"></span>${CATEGORY_LABELS[cat] || cat} (${count})`;
    l.onclick = () => {
      if (state.hiddenCategories.has(cat)) state.hiddenCategories.delete(cat); else state.hiddenCategories.add(cat);
      l.classList.toggle('on');
      renderView();
    };
    host.appendChild(l);
  }
}

// ---------- topbar ----------
function wireTopbar() {
  $('#project-select').onchange = (e) => selectProject(e.target.value, true);
  $('#btn-scan').onclick = () => startScan();
  $('#btn-cancel').onclick = async () => { if (state.project) await api.cancel(state.project.id); };
  $('#btn-add-project').onclick = () => openAddModal();
  $('#btn-ai').onclick = () => { bottom.toggle(); bottom.showTab('ai'); };
  $('#btn-settings').onclick = () => openSettingsModal();
  $('#btn-fullscreen').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  };
  $('#btn-2d3d').onclick = () => {
    if (view instanceof BrainView) {
      const is2d = view.toggle2D();
      $('#btn-2d3d').textContent = is2d ? '3D' : '2D';
    }
  };
  $('#btn-clusters').onclick = () => {
    if (view instanceof BrainView) {
      view.clusterMode = !view.clusterMode;
      $('#btn-clusters').classList.toggle('active', view.clusterMode);
      view.rebuild();
    }
  };
  $('#btn-fit').onclick = () => view?.fit?.();
}

// ---------- search ----------
function wireSearch() {
  const input = $('#search-input');
  const box = $('#search-results');
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { box.classList.add('hidden'); tree.setFilter(''); return; }
    timer = setTimeout(async () => {
      tree.setFilter(q);
      if (!state.project) return;
      try {
        const r = await api.search(state.project.id, q);
        const items = [
          ...r.files.map((f) => ({ kind: 'файл', label: f.path, act: () => selectNode(f.path) })),
          ...r.symbols.slice(0, 60).map((s) => ({ kind: s.kind, label: `${s.name} — ${s.file}:${s.line}`, act: () => { selectNode(s.file); bottom.showCode(s.file); } })),
          ...r.routes.map((rt) => ({ kind: 'роут', label: `${rt.method} ${rt.path} — ${rt.file}:${rt.line}`, act: () => selectNode(rt.file) })),
        ];
        box.innerHTML = items.length
          ? items.slice(0, 80).map((it, i) => `<div class="sr-item" data-i="${i}"><span class="sr-kind">${esc(it.kind)}</span>${esc(it.label)}</div>`).join('')
          : '<div class="sr-item muted">Ничего не найдено</div>';
        box.classList.remove('hidden');
        box.querySelectorAll('.sr-item[data-i]').forEach((el2) => {
          el2.onclick = () => { items[Number(el2.dataset.i)].act(); box.classList.add('hidden'); };
        });
      } catch { /* ignore */ }
    }, 250);
  });
  input.addEventListener('blur', () => setTimeout(() => box.classList.add('hidden'), 200));
}

// ---------- modals ----------
function openModal(html) {
  const m = $('#modal');
  $('#modal-box').innerHTML = html;
  m.classList.remove('hidden');
  return m;
}
function closeModal() { $('#modal').classList.add('hidden'); }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

function wireAddProject() {
  window.openAddModal = openAddModal;
}
function openAddModal() {
  const m = openModal(`
    <h2>Добавить проект</h2>
    <label>Путь к папке проекта (локально, анализ не покидает машину)</label>
    <input id="m-path" placeholder="/home/user/my-project" autofocus>
    <label>Название (необязательно)</label>
    <input id="m-name" placeholder="my-project">
    <div class="row"><button id="m-cancel">Отмена</button><button id="m-ok" class="primary">Добавить и сканировать</button></div>
  `);
  m.querySelector('#m-cancel').onclick = closeModal;
  m.querySelector('#m-ok').onclick = async () => {
    const path = m.querySelector('#m-path').value.trim();
    if (!path) return;
    try {
      const proj = await api.addProject(path, m.querySelector('#m-name').value.trim() || undefined);
      closeModal();
      await loadProjects();
      await selectProject(proj.id, true);
    } catch (e) { alert('Ошибка: ' + e.message); }
  };
  m.querySelector('#m-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') m.querySelector('#m-ok').click(); });
}

async function openSettingsModal() {
  let cfg = { provider: 'openai', endpoint: '', apiKey: '', model: '', enabled: false };
  try { cfg = await api.aiConfig(); } catch {}
  const m = openModal(`
    <h2>Настройки</h2>
    <div class="muted" style="font-size:12px">Весь статический анализ выполняется локально. Код не отправляется никуда, кроме выбранного вами AI-endpoint (если он включён). Секреты и .env автоматически исключаются из AI-контекста.</div>
    <label><input type="checkbox" id="s-enabled" ${cfg.enabled ? 'checked' : ''}> Включить AI-ассистента</label>
    <label>Провайдер</label>
    <select id="s-provider">
      <option value="openai" ${cfg.provider === 'openai' ? 'selected' : ''}>OpenAI-compatible API</option>
      <option value="ollama" ${cfg.provider === 'ollama' ? 'selected' : ''}>Ollama (локально)</option>
      <option value="custom" ${cfg.provider === 'custom' ? 'selected' : ''}>Custom endpoint</option>
    </select>
    <label>Endpoint (например http://127.0.0.1:11434 для Ollama или https://api.openai.com/v1)</label>
    <input id="s-endpoint" value="${esc(cfg.endpoint)}" placeholder="http://127.0.0.1:11434">
    <label>Модель</label>
    <input id="s-model" value="${esc(cfg.model)}" placeholder="llama3.1 / gpt-4o-mini / …">
    <label>API key (необязательно; хранится локально в ~/.codebrain/ai.json)</label>
    <input id="s-key" type="password" value="${esc(cfg.apiKey)}" placeholder="…">
    <div class="row"><button id="s-cancel">Закрыть</button><button id="s-save" class="primary">Сохранить</button></div>
  `);
  m.querySelector('#s-cancel').onclick = closeModal;
  m.querySelector('#s-save').onclick = async () => {
    await api.aiConfigSave({
      enabled: m.querySelector('#s-enabled').checked,
      provider: m.querySelector('#s-provider').value,
      endpoint: m.querySelector('#s-endpoint').value.trim(),
      model: m.querySelector('#s-model').value.trim(),
      apiKey: m.querySelector('#s-key').value,
    });
    bottom.log('Настройки AI сохранены', 'ok');
    closeModal();
  };
}

// ---------- progress ----------
function showProgress(pct, label) {
  $('#progress-overlay').classList.remove('hidden');
  $('#progress-bar').style.width = pct + '%';
  $('#progress-label').textContent = `${label} ${pct ? pct + '%' : ''}`;
}
function hideProgress() { $('#progress-overlay').classList.add('hidden'); }

// ---------- resizers & layout ----------
function applyLayout() {
  const s = state.settings;
  document.documentElement.style.setProperty('--left-w', s.leftW + 'px');
  document.documentElement.style.setProperty('--right-w', s.rightW + 'px');
  document.documentElement.style.setProperty('--bottom-h', s.bottomH + 'px');
}
function wireResizers() {
  const drag = (el, onMove) => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const move = (ev) => onMove(ev);
      const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); saveSettings(); };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    });
  };
  drag($('#res-left'), (ev) => {
    state.settings.leftW = Math.max(180, Math.min(520, ev.clientX));
    applyLayout();
  });
  drag($('#res-right'), (ev) => {
    state.settings.rightW = Math.max(240, Math.min(600, innerWidth - ev.clientX));
    applyLayout();
  });
  drag($('#res-bottom'), (ev) => {
    state.settings.bottomH = Math.max(120, Math.min(innerHeight - 160, innerHeight - ev.clientY));
    applyLayout();
  });
}

// ---------- hotkeys ----------
function wireHotkeys() {
  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    const k = e.key.toLowerCase();
    const idx = ['1', '2', '3', '4', '5', '6', '7', '8'].indexOf(k);
    if (idx >= 0 && VIEWS[idx]) { setView(VIEWS[idx].id); return; }
    if (k === 'f') { e.preventDefault(); $('#search-input').focus(); }
    else if (k === 'r') { startScan(); }
    else if (k === 'b') { bottom.toggle(); }
    else if (k === 'escape') { closeModal(); }
    else if (k === 'g' && state.view === 'brain') { $('#btn-2d3d').click(); }
  });
}
