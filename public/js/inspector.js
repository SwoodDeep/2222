import { api } from './api.js';
import { state, nodeColor, CATEGORY_LABELS, KIND_LABELS } from './state.js';
import { highlight, langFor } from './highlight.js';

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export class Inspector {
  constructor(host, { onSelect, onShowCode, onImpact } = {}) {
    this.host = host;
    this.onSelect = onSelect;
    this.onShowCode = onShowCode;
    this.onImpact = onImpact;
  }

  render(nodeId) {
    const g = state.graph;
    if (!g || !nodeId || !g.nodes.find((n) => n.id === nodeId)) {
      this.host.innerHTML = '<div class="empty muted">Выберите компонент в графе или дереве</div>';
      return;
    }
    const n = g.nodes.find((x) => x.id === nodeId);
    const out = g.edges.filter((e) => e.from === nodeId);
    const inn = g.edges.filter((e) => e.to === nodeId);
    const risks = state.graph.risks?.filter((r) => (r.nodeIds || []).includes(nodeId)) || [];
    const routes = (g.routes || []).filter((r) => r.file === nodeId);

    const depRow = (e, dir) => {
      const other = dir === 'out' ? e.to : e.from;
      const o = g.nodes.find((x) => x.id === other);
      return `<div class="dep" data-id="${esc(other)}"><span class="arrow">${dir === 'out' ? '→' : '←'}</span>
        <span class="badge ${e.confidence}">${e.confidence === 'certain' ? 'точно' : 'предположительно'}</span>
        <span>${esc(KIND_LABELS[e.kind] || e.kind)}</span>
        <span style="color:${o ? nodeColor(o) : '#888'}">${esc(o?.label || other)}</span>
        ${e.detail ? `<span class="muted">${esc(String(e.detail).slice(0, 60))}</span>` : ''}</div>`;
    };

    this.host.innerHTML = `
      <h2>${esc(n.label)}</h2>
      <div class="muted" style="font-family:var(--mono);font-size:11px;word-break:break-all">${esc(n.path)}</div>
      <div style="margin:6px 0">
        <span class="badge cat" style="border-color:${nodeColor(n)};color:${nodeColor(n)}">${esc(CATEGORY_LABELS[n.category] || n.category)}</span>
        <span class="badge">${esc(n.lang || '')}</span>
        <span class="badge">${esc(n.kind)}</span>
        ${n.hasSecrets ? '<span class="badge risk">секреты</span>' : ''}
        ${(n.risk || []).map((r) => `<span class="badge risk">${esc(r)}</span>`).join('')}
      </div>
      <h3>Метрики</h3>
      <div class="kv"><b>Строк кода</b><span>${n.loc ?? '—'}</span></div>
      <div class="kv"><b>Символов</b><span>${n.symbolCount ?? '—'}</span></div>
      <div class="kv"><b>Цикломатическая сложность</b><span>${n.metrics?.complexity ?? '—'}</span></div>
      <div class="kv"><b>Исходящие зависимости</b><span>${n.metrics?.imports ?? 0}</span></div>
      <div class="kv"><b>Входящие зависимости</b><span>${n.metrics?.importedBy ?? 0}</span></div>
      <div class="kv"><b>Архитектурная значимость</b><span>${n.metrics?.importance ?? 0}</span></div>
      <div class="kv"><b>Уверенность анализа</b><span>${n.kind === 'file' ? 'файл подтверждён сканированием' : '—'}</span></div>
      <div class="conf-bar"><div style="width:${Math.min(100, (n.metrics?.importance || 0))}%"></div></div>
      ${routes.length ? `<h3>API-роуты (${routes.length})</h3><div class="dep-list">${routes.map((r) => `<div class="dep"><span class="badge certain">${esc(r.method)}</span><span>${esc(r.path)}</span><span class="muted">→ ${esc(r.handler || '?')} :${r.line}</span></div>`).join('')}</div>` : ''}
      ${risks.length ? `<h3>Проблемы</h3><div class="dep-list">${risks.map((r) => `<div class="dep"><span class="badge risk">${esc(r.severity)}</span><span>${esc(r.message)}</span></div>`).join('')}</div>` : ''}
      <h3>Исходящие зависимости (${out.length})</h3>
      <div class="dep-list">${out.slice(0, 60).map((e) => depRow(e, 'out')).join('') || '<div class="muted">нет</div>'}</div>
      <h3>Входящие зависимости (${inn.length})</h3>
      <div class="dep-list">${inn.slice(0, 60).map((e) => depRow(e, 'in')).join('') || '<div class="muted">нет</div>'}</div>
      <h3>Действия</h3>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${n.kind === 'file' ? `<button data-act="code">Код</button><button data-act="impact">Влияние изменений</button>` : ''}
        <button data-act="center">Центрировать</button>
      </div>
    `;
    this.host.querySelectorAll('.dep[data-id]').forEach((d) => {
      d.onclick = () => this.onSelect?.(d.dataset.id);
    });
    this.host.querySelector('[data-act="code"]')?.addEventListener('click', () => this.onShowCode?.(nodeId));
    this.host.querySelector('[data-act="impact"]')?.addEventListener('click', () => this.onImpact?.(nodeId));
    this.host.querySelector('[data-act="center"]')?.addEventListener('click', () => this.onSelect?.(nodeId, true));
  }
}

export async function loadCodeInto(nodeId, codeEl, metaEl) {
  const p = state.project;
  if (!p || !nodeId) return;
  try {
    const f = await api.file(p.id, nodeId);
    if (f.binary) { codeEl.textContent = '(бинарный файл)'; metaEl.textContent = f.path; return; }
    codeEl.innerHTML = highlight(f.content || '', langFor(f.lang, f.path));
    metaEl.textContent = `${f.path} · ${f.loc ?? '?'} строк · язык: ${f.lang || '?'}${f.hasSecrets ? ' · ⚠ возможны секреты' : ''}`;
    return f;
  } catch (e) {
    codeEl.textContent = 'Ошибка загрузки: ' + e.message;
  }
}
