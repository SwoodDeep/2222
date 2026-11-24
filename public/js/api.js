const BASE = '';

async function req(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.status + ' ' + res.statusText;
    try { const j = await res.json(); if (j.error) msg = j.error; } catch {}
    const e = new Error(msg);
    e.status = res.status;
    e.needScan = (await res.clone().json().catch(() => ({}))).needScan;
    throw e;
  }
  return res.json();
}

export const api = {
  health: () => req('GET', '/api/health'),
  listProjects: () => req('GET', '/api/projects'),
  addProject: (path, name) => req('POST', '/api/projects', { path, name }),
  removeProject: (id) => req('DELETE', `/api/projects/${id}`),
  scan: (id) => req('POST', `/api/projects/${id}/scan`),
  cancel: (id) => req('POST', `/api/projects/${id}/cancel`),
  status: (id) => req('GET', `/api/projects/${id}/status`),
  graph: (id, level = 'files') => req('GET', `/api/projects/${id}/graph?level=${level}`),
  tree: (id) => req('GET', `/api/projects/${id}/tree`),
  file: (id, path) => req('GET', `/api/projects/${id}/file?path=${encodeURIComponent(path)}`),
  search: (id, q) => req('GET', `/api/projects/${id}/search?q=${encodeURIComponent(q)}`),
  impact: (id, path, symbol) => req('GET', `/api/projects/${id}/impact?path=${encodeURIComponent(path)}${symbol ? '&symbol=' + encodeURIComponent(symbol) : ''}`),
  stats: (id) => req('GET', `/api/projects/${id}/stats`),
  risks: (id) => req('GET', `/api/projects/${id}/risks`),
  routes: (id) => req('GET', `/api/projects/${id}/routes`),
  history: (id) => req('GET', `/api/projects/${id}/history`),
  compare: (id, a, b) => req('GET', `/api/projects/${id}/history/compare?a=${a}&b=${b}`),
  git: (id) => req('GET', `/api/projects/${id}/git`),
  aiConfig: () => req('GET', '/api/ai/config'),
  aiConfigSave: (cfg) => req('PUT', '/api/ai/config', cfg),
  events(id, handlers) {
    const es = new EventSource(`/api/projects/${id}/events`);
    for (const [evt, fn] of Object.entries(handlers)) es.addEventListener(evt, (e) => fn(JSON.parse(e.data)));
    return es;
  },
  ask(id, question, handlers) {
    return fetch(`/api/projects/${id}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    }).then(async (res) => {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const evt = block.match(/^event: (.+)$/m)?.[1];
          const data = block.match(/^data: (.+)$/m)?.[1];
          if (evt && data && handlers[evt]) handlers[evt](JSON.parse(data));
        }
      }
    });
  },
};
