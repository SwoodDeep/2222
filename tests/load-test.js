// Load test: generate a synthetic large project, scan it, measure time/memory,
// then modify some files and measure incremental re-scan.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Analyzer } from '../server/analysis/analyzer.js';
import { addProject, removeProject } from '../server/storage/store.js';

const ROOT = path.join(os.tmpdir(), 'codebrain-loadproj');
const N_DIRS = 60;
const FILES_PER_DIR = 50;

function gen() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  let counter = 0;
  for (let d = 0; d < N_DIRS; d++) {
    const dir = path.join(ROOT, `src/module${d}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < FILES_PER_DIR; f++) {
      const id = counter++;
      const deps = [];
      if (id > 0) deps.push(`./file${(id - 1) % FILES_PER_DIR}`);
      if (id > 7) deps.push(`../module${Math.max(0, d - 1)}/file${id % FILES_PER_DIR}`);
      const imports = deps.map((dep) => `import { helper${id} } from '${dep}';`).join('\n');
      const body = Array.from({ length: 40 }, (_, i) => {
        const branch = i % 5;
        if (branch === 0) return `  if (x > ${i}) { acc += ${i}; } else if (x < -${i}) { acc -= ${i}; }`;
        if (branch === 1) return `  for (let j = 0; j < ${i + 1}; j++) { acc += j * x; }`;
        if (branch === 2) return `  switch (x % 3) { case 0: acc += 1; break; case 1: acc += 2; break; default: acc += 3; }`;
        if (branch === 3) return `  acc += x > 0 && x < 100 ? ${i} : -${i};`;
        return `  acc += Math.sin(x * ${i + 1}) * ${i + 1};`;
      }).join('\n');
      const code = `${imports}\n\nexport function helper${id}(x) {\n  let acc = ${id};\n${body}\n  return acc;\n}\n\nexport class Component${id} {\n  constructor() { this.v = ${id}; }\n  render() { return helper${id}(this.v); }\n}\n`;
      fs.writeFileSync(path.join(dir, `file${f}.js`), code);
    }
  }
  fs.writeFileSync(path.join(ROOT, 'package.json'), JSON.stringify({ name: 'loadproj', dependencies: { express: '^4.0.0', lodash: '^4.0.0', axios: '^1.0.0' } }));
  fs.mkdirSync(path.join(ROOT, 'node_modules/somepkg'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'node_modules/somepkg/index.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(ROOT, '.gitignore'), 'node_modules\ndist\n');
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'dist/bundle.min.js'), 'x'.repeat(100000));
  return counter;
}

const analyzer = new Analyzer();
const nFiles = gen();
console.log(`Generated ${nFiles} files in ${ROOT}`);
const project = addProject(ROOT, 'loadproj');

function memMB() { return Math.round(process.memoryUsage().heapUsed / 1024 / 1024); }

console.log('\n--- Full scan ---');
let t0 = Date.now();
let r1 = await analyzer.scan(project, {});
let t1 = Date.now() - t0;
console.log(`files=${r1.stats.files} parsed=${r1.stats.parsed} loc=${r1.stats.loc} symbols=${r1.stats.symbols}`);
console.log(`edges=${r1.stats.edges} nodes=${r1.stats.nodes} risks=${r1.stats.risks}`);
console.log(`time=${t1}ms  heap=${memMB()}MB  rss=${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`);
console.log(`byLang=${JSON.stringify(r1.stats.byLang)}`);

console.log('\n--- Incremental re-scan (cache hit, no changes) ---');
t0 = Date.now();
let r2 = await analyzer.scan(project, {});
t1 = Date.now() - t0;
console.log(`time=${t1}ms edges=${r2.stats.edges} heap=${memMB()}MB`);

console.log('\n--- Incremental re-scan after touching 50 files ---');
for (let i = 0; i < 50; i++) {
  const f = path.join(ROOT, `src/module${i % N_DIRS}/file${i % FILES_PER_DIR}.js`);
  fs.appendFileSync(f, `\nexport const touched${i} = ${i};\n`);
}
t0 = Date.now();
let r3 = await analyzer.scan(project, {});
t1 = Date.now() - t0;
console.log(`time=${t1}ms symbols=${r3.stats.symbols} heap=${memMB()}MB`);

console.log('\n--- Graph JSON payload size ---');
const json = JSON.stringify(r3.graph.toJSON());
console.log(`graph JSON: ${Math.round(json.length / 1024 / 1024 * 10) / 10} MB, nodes=${r3.graph.nodes.size}, edges=${r3.graph.edges.length}`);

const ok = r1.stats.files >= nFiles && r1.stats.edges > nFiles && t1 < 60000;
console.log(`\n==== LOAD TEST ${ok ? 'OK' : 'PROBLEM'} ====`);
removeProject(project.id);
analyzer.terminate();
fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
