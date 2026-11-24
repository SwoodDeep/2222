// E2E smoke test against a running CodeBrain server on 127.0.0.1:4173
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-app');
const BASE = 'http://127.0.0.1:4173';

let passed = 0, failed = 0;
const assert = (c, name, extra) => { if (c) { passed++; console.log('  PASS', name); } else { failed++; console.log('  FAIL', name, extra ?? ''); } };

const j = async (url, opts) => {
  const res = await fetch(BASE + url, opts);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
};

console.log('health...');
let r = await j('/api/health');
assert(r.status === 200 && r.body.ok, 'health');

console.log('add project...');
r = await j('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: FIXTURE, name: 'e2e-sample' }) });
assert(r.status === 200 && r.body.id, 'project added', JSON.stringify(r.body).slice(0, 200));
const id = r.body.id;

r = await j('/api/projects', );
assert(r.body.some((p) => p.id === id), 'project listed');

console.log('scan...');
const t0 = Date.now();
r = await j(`/api/projects/${id}/scan`, { method: 'POST' });
console.log(`  scan responded in ${Date.now() - t0}ms, ok=${r.body.ok}`);
assert(r.status === 200 && r.body.ok, 'scan ok', JSON.stringify(r.body).slice(0, 300));

r = await j(`/api/projects/${id}/status`);
assert(r.body.hasResult, 'has result after scan');

r = await j(`/api/projects/${id}/graph`);
const g = r.body;
assert(g.nodes?.length >= 12, 'graph nodes', g.nodes?.length);
assert(g.edges?.length >= 10, 'graph edges', g.edges?.length);
assert(g.nodes.find((n) => n.id === 'server/index.js')?.position, 'positions present');
assert(g.stats && g.stats.risks >= 2, 'stats+risks', JSON.stringify(g.stats?.bySeverity));

r = await j(`/api/projects/${id}/graph?level=symbols`);
assert(r.body.nodes.some((n) => n.kind === 'symbol'), 'symbol graph has symbol nodes', r.body.nodes?.length);

r = await j(`/api/projects/${id}/tree`);
assert(r.body.name === 'e2e-sample' && r.body.children?.length > 0, 'tree');

r = await j(`/api/projects/${id}/file?path=${encodeURIComponent('server/auth.js')}`);
assert(r.body.content?.includes('checkAuth'), 'file content');
assert(r.body.symbols?.some((s) => s.name === 'checkAuth'), 'file symbols');

r = await j(`/api/projects/${id}/file?path=${encodeURIComponent('../../etc/passwd')}`);
assert(r.status === 400 || r.status === 404, 'path traversal blocked', r.status);

r = await j(`/api/projects/${id}/search?q=auth`);
assert(r.body.symbols?.some((s) => s.name === 'checkAuth'), 'search symbols');
assert(r.body.files?.some((f) => f.path.includes('auth')), 'search files');

r = await j(`/api/projects/${id}/impact?path=${encodeURIComponent('server/db.js')}`);
assert(r.body.impacted?.includes('server/index.js'), 'impact includes index.js', JSON.stringify(r.body.impacted));
assert(r.body.impacted?.includes('server/auth.js'), 'impact includes auth.js');

r = await j(`/api/projects/${id}/stats`);
assert(r.body.files >= 12 && r.body.routes >= 5, 'stats', JSON.stringify({ files: r.body.files, routes: r.body.routes }));

r = await j(`/api/projects/${id}/risks`);
assert(r.body.some((x) => x.type === 'cycle'), 'cycle risk via API');
assert(r.body.some((x) => x.type === 'secret'), 'secret risk via API');

r = await j(`/api/projects/${id}/routes`);
assert(r.body.length >= 5, 'routes endpoint', r.body.length);

r = await j(`/api/projects/${id}/export?format=json`);
assert(r.body.nodes?.length >= 12, 'export json');
r = await j(`/api/projects/${id}/export?format=svg`);
assert(typeof r.body === 'string' && r.body.includes('<svg'), 'export svg');

r = await j(`/api/projects/${id}/report`);
assert(typeof r.body === 'string' && r.body.includes('Архитектурный отчёт'), 'report md');

r = await j(`/api/projects/${id}/history`);
assert(Array.isArray(r.body) && r.body.length >= 1, 'history entries', JSON.stringify(r.body).slice(0, 120));
if (r.body.length >= 1) {
  const a = await j(`/api/projects/${id}/history/compare?a=${r.body[0].ts}&b=${r.body[0].ts}`);
  assert(a.status === 200 && a.body.added.length === 0, 'history compare self');
}

r = await j(`/api/projects/${id}/git`);
assert(r.status === 200 && r.body.available === false, 'git gracefully unavailable in fixture', JSON.stringify(r.body).slice(0, 80));

r = await j('/api/ai/config');
assert(r.status === 200 && r.body.provider, 'ai config');
r = await j('/api/ai/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'llama3', enabled: false, apiKey: '' }) });
assert(r.body.provider === 'ollama', 'ai config save');
r = await j(`/api/projects/${id}/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'test' }) });
assert(r.status === 200, 'ask endpoint responds (stream)');

r = await j(`/`);
assert(typeof r.body === 'string' && r.body.includes('CodeBrain'), 'index.html served');

console.log(`\n==== E2E: ${passed} passed, ${failed} failed ====`);
process.exit(failed ? 1 : 0);
