import { registerParser } from './registry.js';

function parseJson(file, text) {
  const facts = { symbols: [], imports: [], exports: [], calls: [], classes: [], routes: [], network: [], db: [], events: [], components: [] };
  let obj = null;
  try { obj = JSON.parse(text); } catch {
    try { obj = JSON.parse(text.replace(/,(\s*[}\]])/g, '$1')); } catch { return facts; }
  }
  const base = file.path.split('/').pop();
  if (base === 'package.json' && obj && typeof obj === 'object') {
    facts.symbols.push({ name: obj.name || 'package', kind: 'package', line: 1, endLine: 1, signature: `package.json ${obj.name || ''} v${obj.version || ''}`.trim() });
    for (const depField of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const dep of Object.keys(obj[depField] || {})) {
        facts.imports.push({ source: dep, kind: 'npm-dependency', specifiers: [{ imported: '*', local: dep }], line: 1, dynamic: false, depField });
      }
    }
    for (const [scriptName, cmd] of Object.entries(obj.scripts || {})) {
      facts.symbols.push({ name: `script:${scriptName}`, kind: 'entrypoint', line: 1, endLine: 1, signature: cmd.slice(0, 160) });
    }
    if (obj.main) facts.imports.push({ source: obj.main, kind: 'entrypoint', specifiers: [{ imported: 'default', local: 'main' }], line: 1, dynamic: false });
    if (obj.module) facts.imports.push({ source: obj.module, kind: 'entrypoint', specifiers: [{ imported: 'default', local: 'module' }], line: 1, dynamic: false });
    if (obj.bin) for (const b of Object.values(obj.bin)) facts.imports.push({ source: String(b), kind: 'entrypoint', specifiers: [{ imported: 'bin', local: 'bin' }], line: 1, dynamic: false });
  } else if (base === 'tsconfig.json' || base === 'jsconfig.json') {
    facts.symbols.push({ name: base, kind: 'config', line: 1, endLine: 1, signature: 'TS config' });
  } else if (/composer\.json$/.test(file.path)) {
    for (const depField of ['require', 'require-dev']) for (const dep of Object.keys(obj[depField] || {})) facts.imports.push({ source: dep, kind: 'composer-dependency', specifiers: [{ imported: '*', local: dep }], line: 1, dynamic: false });
  } else if (/\.json$/.test(file.path)) {
    facts.symbols.push({ name: base, kind: 'config', line: 1, endLine: 1, signature: 'JSON config/data' });
  }
  return facts;
}

function parseYaml(file, text) {
  const facts = { symbols: [], imports: [], exports: [], calls: [], classes: [], routes: [], network: [], db: [], events: [], components: [] };
  const lines = text.split('\n');
  const base = file.path.split('/').pop();
  const isWorkflow = /\.github[\/]workflows\//.test(file.path);
  const isCompose = /docker-compose/.test(base);
  let section = null;
  lines.forEach((line, i) => {
    const ln = i + 1;
    const m = line.match(/^(\s*)([\w\-\.]+):\s*(.*)$/);
    if (m) {
      const indent = m[1].length;
      const key = m[2];
      if (indent === 0) section = key;
      if (isCompose && section === 'services' && indent === 2) facts.symbols.push({ name: `service:${key}`, kind: 'service', line: ln, endLine: ln, signature: line.trim().slice(0, 120) });
      if (isWorkflow && (key === 'name' || section === 'jobs' && indent === 2)) {
        facts.symbols.push({ name: key === 'name' ? `workflow:${m[3] || base}` : `job:${key}`, kind: key === 'name' ? 'workflow' : 'job', line: ln, endLine: ln, signature: line.trim().slice(0, 120) });
      }
      if (/^(image|build|command|entrypoint|run):/.test(key) && isCompose) {
        facts.symbols.push({ name: `${key}`, kind: 'config', line: ln, endLine: ln, signature: line.trim().slice(0, 120) });
      }
    }
    const imgM = line.match(/image:\s*([\w\/\.:\-]+)/);
    if (imgM) facts.imports.push({ source: imgM[1], kind: 'docker-image', specifiers: [{ imported: '*', local: imgM[1] }], line: ln, dynamic: false });
  });
  return facts;
}

function parseSql(file, text) {
  const facts = { symbols: [], imports: [], exports: [], calls: [], classes: [], routes: [], network: [], db: [], events: [], components: [] };
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    let m;
    const tblRe = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[\`"]?(\w+)[\`"`]?/i;
    if ((m = line.match(tblRe))) facts.symbols.push({ name: m[1], kind: 'table', line: i + 1, endLine: i + 1, signature: line.trim().slice(0, 140) });
    const qRe = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+(?:INDEX|VIEW|TRIGGER|PROCEDURE))\b[\s\S]{0,100}/i;
    if ((m = line.match(qRe))) facts.db.push({ kind: 'sql', detail: m[0].replace(/\s+/g, ' ').slice(0, 140), line: i + 1 });
  });
  return facts;
}

function parseMarkdown(file, text) {
  const facts = { symbols: [], imports: [], exports: [], calls: [], classes: [], routes: [], network: [], db: [], events: [], components: [] };
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const m = line.match(/^\s{0,3}#{1,6}\s+(.+)$/);
    if (m) facts.symbols.push({ name: m[1].trim().slice(0, 80), kind: 'heading', line: i + 1, endLine: i + 1, signature: m[1].trim().slice(0, 100) });
    const linkRe = /\[[^\]]*\]\(([^)\s]+)\)/g;
    let lm;
    while ((lm = linkRe.exec(line))) {
      const target = lm[1];
      if (!/^(https?:|mailto:|#)/.test(target)) facts.imports.push({ source: target.split('#')[0], kind: 'doc-link', specifiers: [{ imported: '*', local: '*' }], line: i + 1, dynamic: false });
    }
  });
  return facts;
}

function parseConfig(file, text) {
  const facts = { symbols: [], imports: [], exports: [], calls: [], classes: [], routes: [], network: [], db: [], events: [], components: [] };
  const base = file.path.split('/').pop();
  facts.symbols.push({ name: base, kind: 'config', line: 1, endLine: 1, signature: 'config file' });
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const m = line.match(/^\s*([\w\.\-]+)\s*[=:]\s*(.*)$/);
    if (m && m[1] && !m[2].startsWith('//')) facts.symbols.push({ name: m[1], kind: 'setting', line: i + 1, endLine: i + 1, signature: `${m[1]} (value hidden)` });
  });
  return facts;
}

function parseToml(file, text) {
  const facts = parseConfig(file, text);
  const base = file.path.split('/').pop();
  if (base === 'pyproject.toml' || base === 'Cargo.toml' || base === 'go.mod') {
    const depRe = /^\s*([\w\-\.]+)\s*=\s*["'`]?[\w\.\*\^~>=< ]+/;
    for (const line of text.split('\n')) {
      if (/^\s*\[(dependencies|dev-dependencies|build-dependencies|workspace\.dependencies)\]/.test(line)) { facts._depSection = true; continue; }
      if (/^\s*\[/.test(line)) facts._depSection = /dependencies/.test(line);
      else if (facts._depSection && (line.match(depRe))) facts.imports.push({ source: line.match(depRe)[1], kind: 'manifest-dependency', specifiers: [{ imported: '*', local: '*' }], line: 1, dynamic: false });
    }
  }
  return facts;
}

function parseShell(file, text) {
  const facts = { symbols: [], imports: [], exports: [], calls: [], classes: [], routes: [], network: [], db: [], events: [], components: [] };
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    let m;
    if ((m = line.match(/^\s*(?:function\s+)?(\w+)\s*\(\)\s*\{/))) facts.symbols.push({ name: m[1], kind: 'function', line: i + 1, endLine: i + 1, signature: line.trim().slice(0, 100) });
    const srcRe = /^\s*(?:source|\.)\s+([\w\-\/\.]+)/;
    if ((m = line.match(srcRe))) facts.imports.push({ source: m[1], kind: 'source', specifiers: [{ imported: '*', local: '*' }], line: i + 1, dynamic: false });
    const curlRe = /\b(curl|wget)\s+[^\n]*?(https?:\/\/[^\s"']+)/;
    if ((m = line.match(curlRe))) facts.network.push({ kind: 'http', url: m[2], method: 'GET', line: i + 1 });
  });
  return facts;
}

registerParser('json', ['.json', '.jsonc'], ['package.json', 'tsconfig.json', 'jsconfig.json', 'composer.json', 'angular.json', '.eslintrc.json', '.prettierrc', 'appsettings.json', '.babelrc'], parseJson);
registerParser('yaml', ['.yaml', '.yml'], ['docker-compose.yml', 'docker-compose.yaml', '.dockerignore'], parseYaml);
registerParser('sql', ['.sql'], [], parseSql);
registerParser('markdown', ['.md', '.markdown', '.txt'], [], parseMarkdown);
registerParser('toml', ['.toml'], ['pyproject.toml', 'Cargo.toml'], parseToml);
registerParser('ini', ['.ini', '.cfg', '.conf', '.env', '.gitignore', '.dockerignore', '.editorconfig'], [], parseConfig);
registerParser('shell', ['.sh', '.bash', '.zsh', '.ps1', '.bat'], [], parseShell);
registerParser('misc', ['.xml', '.graphql', '.gql', '.prisma'], [], parseConfig);
registerParser('dockerfile', [], ['dockerfile', 'makefile'], parseConfig);
