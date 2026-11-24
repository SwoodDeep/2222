import { registerParser } from './registry.js';

function parseHtml(file, text) {
  const facts = { symbols: [], imports: [], exports: [], calls: [], classes: [], routes: [], network: [], db: [], events: [], components: [] };
  const re = /<(script|link|img|source|video|audio|a|form)\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(text))) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    const line = text.slice(0, m.index).split('\n').length;
    const get = (name) => {
      const am = attrs.match(new RegExp(name + '\\s*=\\s*["\']([^"\']+)["\']', 'i'));
      return am ? am[1] : null;
    };
    if (tag === 'script') {
      const src = get('src');
      if (src) facts.imports.push({ source: src, kind: 'script', specifiers: [{ imported: '*', local: '*' }], line, dynamic: false });
      else if (/type\s*=\s*["']module["']/i.test(attrs)) facts.symbols.push({ name: 'inline-module-script', kind: 'script', line, endLine: line, signature: 'inline <script type=module>' });
    } else if (tag === 'link') {
      const href = get('href');
      if (href && !href.startsWith('http')) facts.imports.push({ source: href, kind: 'stylesheet', specifiers: [{ imported: '*', local: '*' }], line, dynamic: false });
    } else if (tag === 'form') {
      const action = get('action');
      if (action) facts.routes.push({ method: (get('method') || 'GET').toUpperCase(), path: action, handler: null, line, framework: 'html-form' });
    } else if (tag === 'a') {
      const href = get('href');
      if (href && !href.startsWith('http') && !href.startsWith('#') && !href.startsWith('mailto:')) facts.imports.push({ source: href, kind: 'link', specifiers: [{ imported: '*', local: '*' }], line, dynamic: false });
    }
  }
  // inline scripts: extract fetch/import heuristics
  const scriptRe = /<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi;
  let sm;
  while ((sm = scriptRe.exec(text))) {
    const body = sm[1];
    const line = text.slice(0, sm.index).split('\n').length;
    const fetchRe = /\bfetch\(\s*['"`]([^'"`]+)['"`]/g;
    let fm;
    while ((fm = fetchRe.exec(body))) facts.network.push({ kind: 'http', url: fm[1], method: 'GET', line });
    const importRe = /\bimport\s+(?:[\w*{}\s,]+\s+from\s+)?['"`]([^'"`]+)['"`]/g;
    while ((fm = importRe.exec(body))) facts.imports.push({ source: fm[1], kind: 'import', specifiers: [{ imported: '*', local: '*' }], line, dynamic: false });
    const wsRe = /new\s+WebSocket\(\s*['"`]([^'"`]+)['"`]/g;
    while ((fm = wsRe.exec(body))) facts.network.push({ kind: 'websocket', url: fm[1], line });
  }
  return facts;
}

function parseCss(file, text) {
  const facts = { symbols: [], imports: [], exports: [], calls: [], classes: [], routes: [], network: [], db: [], events: [], components: [] };
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    let m;
    const impRe = /@import\s+(?:url\()?\s*['"]?([^'")]+)['"]?\s*\)?/g;
    while ((m = impRe.exec(line))) facts.imports.push({ source: m[1], kind: 'css-import', specifiers: [{ imported: '*', local: '*' }], line: i + 1, dynamic: false });
    const selRe = /^\s*([.#]?[\w\-]+(?:[\s,>+~][^{]+)?)\s*\{/;
    if ((m = line.match(selRe))) facts.symbols.push({ name: m[1].trim().slice(0, 60), kind: 'selector', line: i + 1, endLine: i + 1, signature: m[1].trim().slice(0, 80) });
  });
  return facts;
}

function extractScriptBlocks(text) {
  const blocks = [];
  const re = /<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(text))) blocks.push(m[1]);
  return blocks;
}

function parseVue(file, text) {
  const facts = { symbols: [], imports: [], exports: [], calls: [], classes: [], routes: [], network: [], db: [], events: [], components: [] };
  const nameM = text.match(/name\s*:\s*['"]([\w\-]+)['"]/);
  facts.components.push({ name: nameM ? nameM[1] : file.path.split('/').pop().replace(/\.vue$/, ''), line: 1 });
  for (const block of extractScriptBlocks(text)) {
    const sub = parseJsLike(block);
    for (const k of Object.keys(facts)) if (Array.isArray(facts[k])) facts[k].push(...sub[k]);
  }
  const tplRe = /<template>([\s\S]*?)<\/template>/i;
  const tpl = text.match(tplRe);
  if (tpl) {
    const compRe = /<([A-Z][\w\-]*)(\s|>|\/)/g;
    let m;
    while ((m = compRe.exec(tpl[1]))) facts.calls.push({ name: m[1], line: 1 });
    const evRe = /@(\w+)=["'][^"']*["']|v-on:(\w+)=/g;
    while ((m = evRe.exec(tpl[1]))) facts.events.push({ kind: 'dom-event', name: m[1] || m[2], line: 1 });
  }
  return facts;
}

function parseSvelte(file, text) {
  const facts = { symbols: [], imports: [], exports: [], calls: [], classes: [], routes: [], network: [], db: [], events: [], components: [] };
  facts.components.push({ name: file.path.split('/').pop().replace(/\.svelte$/, ''), line: 1 });
  for (const block of extractScriptBlocks(text)) {
    const sub = parseJsLike(block);
    for (const k of Object.keys(facts)) if (Array.isArray(facts[k])) facts[k].push(...sub[k]);
  }
  const evRe = /on:(\w+)=/g;
  let m;
  while ((m = evRe.exec(text))) facts.events.push({ kind: 'dom-event', name: m[1], line: 1 });
  return facts;
}

// lightweight JS-ish extraction for embedded script blocks (no AST dependency)
function parseJsLike(text) {
  const facts = { symbols: [], imports: [], exports: [], calls: [], classes: [], routes: [], network: [], db: [], events: [], components: [] };
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const ln = i + 1;
    let m;
    const impRe = /\bimport\s+(?:([\w*{}\s,]+)\s+from\s+)?['"`]([^'"`]+)['"`]/g;
    while ((m = impRe.exec(line))) {
      const specifiers = (m[1] || '*').replace(/[{}]/g, '').split(',').map((s) => s.trim()).filter(Boolean)
        .map((s) => ({ imported: s.split(' as ')[0].trim() || '*', local: (s.split(' as ')[1] || s).trim() }));
      facts.imports.push({ source: m[2], kind: 'import', specifiers, line: ln, dynamic: false });
    }
    const expRe = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)?/g;
    while ((m = expRe.exec(line))) {
      facts.exports.push({ name: m[1] || 'default', kind: m[1] ? 'named' : 'default', line: ln });
      if (m[1]) facts.symbols.push({ name: m[1], kind: 'function', line: ln, endLine: ln, signature: line.trim().slice(0, 120) });
    }
    const fnRe = /\b(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?function)/;
    if ((m = line.match(fnRe))) {
      const name = m[1] || m[2] || m[3];
      if (name) facts.symbols.push({ name, kind: /^[A-Z]/.test(name) ? 'component' : 'function', line: ln, endLine: ln, signature: line.trim().slice(0, 120) });
    }
    const callRe = /\b([A-Za-z_]\w*)\s*\(/g;
    while ((m = callRe.exec(line))) {
      if (!['if', 'for', 'while', 'function', 'return', 'import', 'export', 'const', 'let', 'var', 'new', 'switch', 'catch'].includes(m[1])) facts.calls.push({ name: m[1], line: ln });
    }
    const netRe = /\bfetch\(\s*['"`]([^'"`]+)['"`]|axios\.\w+\(\s*['"`]([^'"`]+)['"`]|new\s+WebSocket\(\s*['"`]([^'"`]+)['"`]/g;
    while ((m = netRe.exec(line))) facts.network.push({ kind: /WebSocket/.test(m[0]) ? 'websocket' : 'http', url: m[1] || m[2] || m[3], method: 'GET', line: ln });
    const evRe = /\.(addEventListener|on|emit)\(\s*['"`]([\w\-:.]+)['"`]/g;
    while ((m = evRe.exec(line))) facts.events.push({ kind: m[1], name: m[2], line: ln });
  });
  return facts;
}

registerParser('html', ['.html', '.htm'], [], parseHtml);
registerParser('css', ['.css', '.scss', '.less', '.sass'], [], parseCss);
registerParser('vue', ['.vue'], [], parseVue);
registerParser('svelte', ['.svelte'], [], parseSvelte);
