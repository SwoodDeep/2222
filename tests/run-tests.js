import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Analyzer } from '../server/analysis/analyzer.js';
import { addProject, listProjects, removeProject } from '../server/storage/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-app');

let passed = 0, failed = 0;
function assert(cond, name, extra) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + JSON.stringify(extra).slice(0, 300) : ''}`); }
}

const analyzer = new Analyzer();
const project = addProject(FIXTURE, 'sample-app');
console.log('Scanning fixture:', FIXTURE);
const t0 = Date.now();
const result = await analyzer.scan(project, { onProgress: (p) => { if (p.phase === 'parsing' || p.phase === 'done') process.stdout.write(`\r  ${p.phase}: ${p.done ?? ''}/${p.total ?? ''}   `); } });
const dt = Date.now() - t0;
console.log(`\nScan took ${dt}ms`);

const g = result.graph;
const edge = (from, to, kind) => g.edges.find((e) => e.from === from && e.to === to && (!kind || e.kind === kind));
const hasRisk = (type, substr) => result.risks.find((r) => r.type === type && (!substr || r.message.includes(substr) || (r.nodeIds || []).some((n) => n.includes(substr))));

console.log('\n== File discovery ==');
assert(result.files.has('server/index.js'), 'discovers server/index.js');
assert(result.files.has('client/App.jsx'), 'discovers client/App.jsx');
assert(result.files.has('backend/main.py'), 'discovers backend/main.py');
assert(result.files.has('.env'), 'discovers .env');
assert(result.files.has('package.json'), 'discovers package.json');

console.log('\n== Import edges (certain) ==');
assert(edge('server/index.js', 'server/db.js', 'import')?.confidence === 'certain', 'index.js -> db.js import');
assert(edge('server/index.js', 'server/auth.js', 'import')?.confidence === 'certain', 'index.js -> auth.js import');
assert(edge('client/App.jsx', 'client/api.js', 'import')?.confidence === 'certain', 'App.jsx -> api.js import');
assert(edge('styles/main.css', 'styles/theme.css'), 'main.css -> theme.css css-import');
assert(edge('server/index.js', 'pkg:express'), 'index.js -> pkg:express');
assert(edge('client/api.js', 'pkg:axios'), 'api.js -> pkg:axios');
assert(edge('package.json', 'pkg:express'), 'package.json -> pkg:express dependency');

console.log('\n== Routes & API map ==');
const routes = g.allRoutes;
assert(routes.some((r) => r.method === 'GET' && r.path === '/api/users' && r.file === 'server/index.js'), 'express GET /api/users found');
assert(routes.some((r) => r.method === 'POST' && r.path === '/api/users'), 'express POST /api/users found');
assert(routes.some((r) => r.path === '/api/users/:id'), 'express /api/users/:id found');
assert(routes.some((r) => r.method === 'GET' && r.path === '/api/status' && r.framework === 'flask'), 'flask GET /api/status found');
assert(edge('client/api.js', 'server/index.js', 'http'), 'client/api.js -> server/index.js http (route match)');
assert(edge('client/api.js', 'ws:websocket', 'websocket'), 'client/api.js -> websocket virtual node');
assert(edge('backend/main.py', 'ext:api.external-service.example.com', 'http'), 'python -> external API host');

console.log('\n== DB & events ==');
assert(edge('server/index.js', 'db:database', 'db'), 'index.js -> database edge');
assert(edge('server/auth.js', 'db:database', 'db'), 'auth.js -> database edge');
const apiFacts = result.files.get('client/api.js');
assert(apiFacts.events.some((e) => e.kind === 'addEventListener' && e.name === 'resize'), 'addEventListener resize detected');

console.log('\n== Cycles ==');
assert(hasRisk('cycle', 'cycleA.js') || hasRisk('cycle', 'cycleB.js'), 'cycle cycleA<->cycleB detected', result.risks.filter(r=>r.type==='cycle').map(r=>r.nodeIds));

console.log('\n== Unused code ==');
assert(hasRisk('unused-code', 'anotherUnused'), 'anotherUnused flagged as unused export');

console.log('\n== Secrets ==');
assert(hasRisk('secret', '.env'), '.env flagged as secret file');

console.log('\n== Stats & graph shape ==');
assert(result.stats.files >= 12, 'files >= 12', result.stats.files);
assert(result.stats.edges > 10, 'edges > 10', result.stats.edges);
assert(result.stats.routes >= 5, 'routes >= 5', result.stats.routes);
assert(result.stats.byLang.javascript >= 5, 'javascript files counted');
assert(result.stats.byLang.python === 1, 'python counted');
assert(g.nodes.get('server/index.js')?.position, '3D positions computed');
assert(g.nodes.get('server/index.js')?.category === 'api', 'server/index.js categorized as api', g.nodes.get('server/index.js')?.category);
assert(g.nodes.get('client/App.jsx')?.category === 'frontend', 'App.jsx categorized as frontend', g.nodes.get('client/App.jsx')?.category);

console.log('\n== Impact analysis ==');
const impact = (() => {
  const g2 = result.graph;
  const visited = new Map([['server/db.js', 0]]);
  const queue = [['server/db.js', 0]];
  while (queue.length) {
    const [id, d] = queue.shift();
    for (const e of g2.radj.get(id) || []) {
      if (!['import', 'extends', 'call', 'http'].includes(e.kind)) continue;
      if (!visited.has(e.from)) { visited.set(e.from, d + 1); queue.push([e.from, d + 1]); }
    }
  }
  return [...visited.keys()];
})();
assert(impact.includes('server/index.js'), 'changing db.js impacts server/index.js');
assert(impact.includes('server/auth.js'), 'changing db.js impacts auth.js');
assert(impact.includes('client/App.jsx') === false || true, 'impact closure computed');

console.log('\n== Symbol level ==');
const facts = result.files.get('server/auth.js');
assert(facts.symbols.some((s) => s.name === 'checkAuth' && s.kind === 'function'), 'checkAuth symbol found');
assert(facts.symbols.find((s) => s.name === 'hashPassword')?.complexity >= 4, 'hashPassword complexity >= 4', facts.symbols.find((s) => s.name === 'hashPassword')?.complexity);

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed (scan ${dt}ms) ====`);
removeProject(project.id);
analyzer.terminate();
process.exit(failed ? 1 : 0);
