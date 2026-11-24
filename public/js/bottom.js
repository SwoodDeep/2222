import { api } from './api.js';
import { state, CATEGORY_LABELS } from './state.js';
import { loadCodeInto } from './inspector.js';

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export class BottomPanel {
  constructor() {
    this.panel = document.getElementById('bottom-panel');
    this.logs = document.getElementById('tab-logs');
    this.open = state.settings.bottomOpen;
    this.apply();
    document.querySelectorAll('#bottom-tabs button').forEach((b) => {
      b.onclick = () => this.showTab(b.dataset.tab);
    });
    this.showTab('logs');
    this._wireAi();
  }

  toggle() { this.open = !this.open; state.settings.bottomOpen = this.open; this.apply(); }
  apply() { this.panel.classList.toggle('collapsed', !this.open); }
  showTab(name) {
    document.querySelectorAll('#bottom-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab-page').forEach((p) => p.classList.add('hidden'));
    document.getElementById('tab-' + name).classList.remove('hidden');
    if (name === 'diagnostics') this.renderDiagnostics();
    if (name === 'ai') this.renderAiConfigHint();
  }

  log(msg, level = 'info') {
    const line = document.createElement('div');
    line.className = 'l-' + level;
    const t = new Date().toLocaleTimeString('ru-RU');
    line.textContent = `[${t}] ${msg}`;
    this.logs.appendChild(line);
    this.logs.scrollTop = this.logs.scrollHeight;
    while (this.logs.children.length > 800) this.logs.firstChild.remove();
  }

  async showCode(nodeId) {
    this.open = true; this.apply();
    this.showTab('code');
    const codeEl = document.getElementById('code-view');
    const metaEl = document.getElementById('code-meta');
    codeEl.textContent = 'Загрузка…';
    await loadCodeInto(nodeId, codeEl, metaEl);
  }

  async renderDiagnostics() {
    const host = document.getElementById('tab-diagnostics');
    const p = state.project;
    if (!p || !state.graph) { host.innerHTML = '<span class="muted">Нет данных. Сначала просканируйте проект.</span>'; return; }
    const s = state.graph.stats;
    const risks = state.graph.risks || [];
    let html = `<h3 style="margin:4px 0">Статистика проекта</h3>
      <table><tr><th>Метрика</th><th>Значение</th></tr>
      <tr><td>Файлов (пропущено)</td><td>${s.files} (${s.skipped})</td></tr>
      <tr><td>Строк кода</td><td>${s.loc}</td></tr>
      <tr><td>Символов</td><td>${s.symbols}</td></tr>
      <tr><td>Узлов / рёбер графа</td><td>${s.nodes} / ${s.edges}</td></tr>
      <tr><td>API-роутов</td><td>${s.routes}</td></tr>
      <tr><td>Внешних пакетов</td><td>${s.externalPackages}</td></tr>
      <tr><td>Неразрешённых импортов</td><td>${s.unresolvedImports}</td></tr>
      <tr><td>Рисков</td><td>${s.risks} (${Object.entries(s.bySeverity || {}).map(([k, v]) => `${k}:${v}`).join(', ') || 'нет'})</td></tr>
      <tr><td>Языки</td><td>${esc(Object.entries(s.byLang || {}).map(([k, v]) => `${k}×${v}`).join(', '))}</td></tr>
      <tr><td>Рёбра</td><td>${esc(Object.entries(s.edgeKinds || {}).map(([k, v]) => `${k}×${v}`).join(', '))}</td></tr></table>
      <h3 style="margin:12px 0 4px">Экспорт и отчёты</h3>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <a class="badge" href="/api/projects/${p.id}/export?format=json" download>Граф (JSON)</a>
        <a class="badge" href="/api/projects/${p.id}/export?format=svg" download>Граф (SVG)</a>
        <a class="badge" href="/api/projects/${p.id}/report" download>Архитектурный отчёт (MD)</a>
      </div>
      <h3 style="margin:12px 0 4px">Риски и диагностика (${risks.length})</h3>`;
    const sevOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    html += risks.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]).slice(0, 300).map((r) =>
      `<div class="risk-row" data-nodes="${esc((r.nodeIds || []).join(','))}"><span class="sev-${r.severity}">●</span> <b>${esc(r.type)}</b> [${esc(r.severity)}] — ${esc(r.message)}</div>`
    ).join('');
    html += `<h3 style="margin:12px 0 4px">История анализов</h3><div id="history-box" class="muted">Загрузка…</div>
      <h3 style="margin:12px 0 4px">Git</h3><div id="git-box" class="muted">Загрузка…</div>`;
    host.innerHTML = html;
    host.querySelectorAll('.risk-row').forEach((r) => {
      r.onclick = () => {
        const first = (r.dataset.nodes || '').split(',')[0];
        if (first) window.dispatchEvent(new CustomEvent('codebrain:select', { detail: first }));
      };
    });
    api.history(p.id).then((h) => {
      const box = host.querySelector('#history-box');
      if (!h.length) { box.textContent = 'Пока нет сохранённых снимков.'; return; }
      box.innerHTML = h.slice(0, 12).map((x) => `<div>• ${new Date(x.ts).toLocaleString('ru-RU')} — ${x.size} байт <a class="badge" href="#" data-ts="${x.ts}">сравнить с последним</a></div>`).join('');
      box.querySelectorAll('a[data-ts]').forEach((a) => a.onclick = async (ev) => {
        ev.preventDefault();
        const last = h[0];
        if (String(last.ts) === a.dataset.ts) { box.insertAdjacentHTML('beforeend', '<div class="muted">это последний снимок</div>'); return; }
        const cmp = await api.compare(p.id, a.dataset.ts, last.ts);
        box.insertAdjacentHTML('beforeend', `<pre style="font-size:11px;background:var(--bg-inset);padding:6px;border-radius:6px">Добавлено файлов: ${cmp.added.length}, удалено: ${cmp.removed.length}, изменено: ${cmp.changed.length}\nΔ строк кода: ${cmp.locDelta}, Δ файлов: ${cmp.fileDelta}, рисков было/стало: ${cmp.risksA}/${cmp.risksB}</pre>`);
      });
    }).catch(() => {});
    api.git(p.id).then((g) => {
      const box = host.querySelector('#git-box');
      if (!g.available) { box.textContent = 'Git-репозиторий не найден.'; return; }
      box.innerHTML = `<div>Ветка: <b>${esc(g.branch)}</b>, изменённых файлов: ${g.dirtyFiles}</div>
        <div style="margin-top:4px">Последние коммиты:</div>
        <pre style="font-size:11px;background:var(--bg-inset);padding:6px;border-radius:6px;max-height:140px;overflow:auto">${esc(g.commits.join('\n'))}</pre>`;
    }).catch(() => {});
  }

  _wireAi() {
    const input = document.getElementById('ai-input');
    const send = document.getElementById('ai-send');
    const doSend = async () => {
      const q = input.value.trim();
      if (!q || !state.project) return;
      input.value = '';
      const box = document.getElementById('ai-messages');
      const um = document.createElement('div');
      um.className = 'ai-msg user'; um.textContent = q;
      box.appendChild(um);
      const am = document.createElement('div');
      am.className = 'ai-msg assistant'; am.textContent = '…';
      box.appendChild(am);
      box.scrollTop = box.scrollHeight;
      try {
        await api.ask(state.project.id, q, {
          token: (d) => { am.textContent += d.text; box.scrollTop = box.scrollHeight; },
          done: (d) => { am.textContent = d.full; addRefs(am); },
          error: (d) => { am.textContent = 'Ошибка: ' + d.message; },
        });
      } catch (e) { am.textContent = 'Ошибка: ' + e.message; }
      box.scrollTop = box.scrollHeight;
    };
    send.onclick = doSend;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });
  }

  renderAiConfigHint() {
    // hint is shown in settings modal; nothing here
  }
}

function addRefs(el) {
  const refs = [...el.textContent.matchAll(/([\w\-./]+\.(?:js|ts|jsx|tsx|py|java|go|rs|cs|php|vue|svelte|css|html|json|ya?ml|sql|md|toml)):(\d+)/g)];
  if (refs.length) {
    const div = document.createElement('div');
    div.className = 'refs';
    div.textContent = 'Ссылки: ' + [...new Set(refs.map((m) => m[0]))].slice(0, 10).join('  ');
    el.appendChild(div);
  }
}
