import path from 'node:path';

const parsers = new Map();

export function registerParser(id, exts, basenames, parseFn) {
  const p = { id, exts: new Set(exts), basenames: new Set(basenames || []), parse: parseFn };
  parsers.set(id, p);
  for (const e of exts) byExt.set(e, p);
  for (const b of p.basenames) byBase.set(b.toLowerCase(), p);
}

const byExt = new Map();
const byBase = new Map();

export function getParserFor(filePath) {
  const base = path.basename(filePath).toLowerCase();
  if (byBase.has(base)) return byBase.get(base);
  const ext = path.extname(filePath).toLowerCase();
  if (byExt.has(ext)) return byExt.get(ext);
  if (base === 'dockerfile' || base === 'makefile') return byBase.get(base);
  return null;
}

export function emptyFacts(file) {
  return {
    path: file.path,
    lang: 'text',
    size: file.size,
    loc: 0,
    symbols: [],
    imports: [],
    exports: [],
    calls: [],
    classes: [],
    routes: [],
    network: [],
    db: [],
    events: [],
    components: [],
    raw: null,
  };
}

export function detectLanguage(filePath) {
  const p = getParserFor(filePath);
  return p ? p.id : 'text';
}
