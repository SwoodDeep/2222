import { registerParser } from './registry.js';

const IMPORT_RE = /^\s*(?:from\s+([\w\.]+)\s+import\s+(.+)|import\s+(.+))\s*$/;
const DEF_RE = /^(\s*)def\s+(\w+)\s*\(([^)]*)\)/;
const CLASS_RE = /^(\s*)class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/;
const DECORATOR_RE = /^\s*@([\w\.]+)(?:\((.*)\))?\s*$/;
const CALL_RE = /\b([A-Za-z_]\w*)\s*\(/g;
const ASSIGN_RE = /^\s*(\w+)\s*=/;

const FLASK_ROUTE_RE = /route\(\s*['"`]([^'"`]+)['"`]\s*(?:,\s*methods\s*=\s*\[([^\]]+)\])?/;
const FASTAPI_ROUTE_RE = /^(get|post|put|delete|patch|websocket)\(\s*['"`]([^'"`]+)['"`]/;

function complexityOfBlock(lines, startIdx, indent) {
  let c = 1;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    const ind = l.match(/^\s*/)[0].length;
    if (ind <= indent) break;
    const t = l.trim();
    if (/^(if|elif|for|while|except|with)\b/.test(t) || /\b(and|or)\b/.test(t) || /\bif\b.*\belse\b/.test(t)) c++;
    if (/\belse\s*:/.test(t)) c++;
  }
  return c;
}

function parse(file, text) {
  const lines = text.split('\n');
  const facts = { symbols: [], imports: [], exports: [], calls: [], classes: [], routes: [], network: [], db: [], events: [], components: [] };
  let currentClass = null;
  let pendingDecorators = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;
    let m;
    if ((m = line.match(IMPORT_RE))) {
      if (m[1]) {
        const specifiers = m[2].split(',').map((s) => s.trim().replace(/\s+as\s+(\w+)$/, (_, a) => '')).filter(Boolean)
          .map((s) => ({ imported: s.split(' as ')[0].trim(), local: (s.split(' as ')[1] || s.split(' as ')[0]).trim() }));
        facts.imports.push({ source: m[1], kind: 'from', specifiers, line: ln, dynamic: false });
      } else {
        for (const part of m[3].split(',')) {
          const p = part.trim();
          if (!p) continue;
          const [src, alias] = p.split(/\s+as\s+/);
          facts.imports.push({ source: src, kind: 'import', specifiers: [{ imported: '*', local: alias || src.split('.').pop() }], line: ln, dynamic: false });
        }
      }
      continue;
    }
    if ((m = line.match(DECORATOR_RE))) {
      pendingDecorators.push({ dec: m[1], args: m[2] || '', line: ln });
      continue;
    }
    if ((m = line.match(CLASS_RE))) {
      const indent = m[1].length;
      const bases = m[3] ? m[3].split(',').map((s) => s.trim()).filter(Boolean) : [];
      currentClass = { name: m[2], indent, line: ln };
      facts.classes.push({ name: m[2], extends: bases[0] || null, line: ln, methods: [] });
      facts.symbols.push({ name: m[2], kind: 'class', line: ln, endLine: ln, signature: `class ${m[2]}(${m[3] || ''})` });
      pendingDecorators = [];
      continue;
    }
    if ((m = line.match(DEF_RE))) {
      const indent = m[1].length;
      const name = m[2];
      const params = m[3].trim();
      const isMethod = currentClass && indent > currentClass.indent;
      const isDunder = name.startsWith('__') && name.endsWith('__');
      if (isMethod) {
        const cls = facts.classes.find((c) => c.name === currentClass.name);
        if (cls) cls.methods.push({ name, line: ln, complexity: complexityOfBlock(lines, i, indent) });
      }
      if (!isDunder) {
        facts.symbols.push({ name, kind: isMethod ? 'method' : 'function', line: ln, endLine: ln, signature: `def ${name}(${params})`.slice(0, 160), complexity: complexityOfBlock(lines, i, indent) });
        if (indent === 0) facts.exports.push({ name, kind: 'named', line: ln });
      }
      // routes via decorators
      for (const d of pendingDecorators) {
        const lastSeg = (d.dec.split('.').pop() || '').toLowerCase();
        const pathM = d.args.match(/['"`]([^'"`]+)['"`]/);
        if (!pathM) { continue; }
        if (lastSeg === 'route') {
          const mM = d.args.match(/methods\s*=\s*\[([^\]]+)\]/);
          const methods = mM ? mM[1].replace(/['"]/g, '').split(',').map((s) => s.trim().toUpperCase()) : ['GET'];
          for (const meth of methods) facts.routes.push({ method: meth, path: pathM[1], handler: name, line: d.line, framework: 'flask' });
        } else if (['get', 'post', 'put', 'delete', 'patch', 'websocket'].includes(lastSeg)) {
          const meth = lastSeg.toUpperCase();
          facts.routes.push({ method: meth === 'WEBSOCKET' ? 'WS' : meth, path: pathM[1], handler: name, line: d.line, framework: 'fastapi' });
        }
      }
      pendingDecorators = [];
      continue;
    }
    if (pendingDecorators.length && line.trim() && !line.trim().startsWith('@')) pendingDecorators = [];

    // top-level assignments = module constants / exports
    if ((m = line.match(ASSIGN_RE)) && !line.includes('(')) {
      const name = m[1];
      if (/^[A-Z_][A-Z0-9_]*$/.test(name) && /^[^\s]/.test(line)) {
        facts.symbols.push({ name, kind: 'constant', line: ln, endLine: ln, signature: name });
      }
    }

    // calls
    CALL_RE.lastIndex = 0;
    let cm;
    while ((cm = CALL_RE.exec(line))) {
      const name = cm[1];
      if (!['if', 'for', 'while', 'def', 'class', 'import', 'from', 'return', 'print', 'len', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple', 'type', 'super', 'range', 'enumerate', 'zip', 'map', 'filter', 'isinstance', 'lambda', 'with', 'as', 'in', 'not', 'and', 'or', 'assert', 'raise', 'try', 'except', 'finally', 'else', 'elif', 'del', 'pass', 'break', 'continue', 'global', 'nonlocal', 'yield', 'await', 'async'].includes(name)) {
        facts.calls.push({ name, line: ln });
      }
    }

    // network
    if (/\b(requests\.(get|post|put|delete|patch|request)\s*\(|httpx\.(get|post|request)\s*\(|aiohttp\.\w+\s*\(|urlopen\s*\(|websocket\.connect\s*\(|websockets\.connect\s*\()/.test(line)) {
      const urlM = line.match(/['"`]([^'"`]{3,200})['"`]/);
      const kind = /websocket/i.test(line) ? 'websocket' : 'http';
      facts.network.push({ kind, url: urlM ? urlM[1] : null, method: (line.match(/\.(get|post|put|delete|patch)\(/i) || [])[1]?.toUpperCase() || 'GET', line: ln });
    }
    // db
    if (/\b(execute|executemany|fetchall|fetchone)\s*\(/.test(line) || /\.(objects\.(get|filter|all|create)|save|find|find_one|insert_one|update_one|delete_one)\s*\(/.test(line) || /\b(sqlalchemy|psycopg2|pymysql|pymongo|motor|asyncpg|peewee|peewee|django\.db)\b/.test(line)) {
      const sqlM = line.match(/["'`](SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)[\s\S]{0,120}/i);
      facts.db.push({ kind: sqlM ? 'sql' : 'orm', detail: sqlM ? sqlM[0].slice(0, 120) : line.trim().slice(0, 120), line: ln });
    }
    // events
    const evM = line.match(/\.(on|once|emit|add_listener|addEventListener|subscribe)\(\s*['"`]([\w\-:.]+)['"`]/);
    if (evM) facts.events.push({ kind: evM[1], name: evM[2], line: ln });
    if (/@(receiver|signal|on_event|app\.websocket)/.test(line)) {
      const nm = line.match(/\(\s*['"`]([\w\-:.]+)['"`]/);
      if (nm) facts.events.push({ kind: 'decorator', name: nm[1], line: ln });
    }
  }
  return facts;
}

registerParser('python', ['.py', '.pyi'], [], parse);
