import path from 'node:path';

const JS_EXTS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.vue', '.svelte'];
const PY_EXTS = ['.py', '.pyi'];

function packageName(spec) {
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    return parts.length >= 2 ? parts[0] + '/' + parts[1] : parts[0];
  }
  return spec.split('/')[0];
}

export class DependencyResolver {
  constructor(rootPath, files) {
    this.root = rootPath;
    this.fileSet = new Set(files.keys());
    this.byBase = new Map();
    for (const p of this.fileSet) {
      const noExt = p.replace(/\.[^.]+$/, '');
      if (!this.byBase.has(noExt)) this.byBase.set(noExt, []);
      this.byBase.get(noExt).push(p);
    }
  }

  resolveJs(fromFile, source) {
    if (!source.startsWith('.') && !source.startsWith('/')) return { external: packageName(source) };
    const baseDir = path.posix.dirname(fromFile);
    const joined = source.startsWith('/')
      ? source.slice(1)
      : path.posix.normalize(path.posix.join(baseDir, source));
    const candidates = [];
    for (const ext of JS_EXTS) candidates.push(joined + ext);
    for (const ext of JS_EXTS) candidates.push(joined + '/index' + ext);
    candidates.push(joined);
    for (const c of candidates) if (this.fileSet.has(c)) return { file: c };
    // try case variations / partial
    if (this.byBase.has(joined)) return { file: this.byBase.get(joined)[0] };
    return { external: source.startsWith('.') ? null : packageName(source), unresolved: source.startsWith('.') };
  }

  resolvePython(fromFile, source, kind) {
    let s = source;
    if (kind === 'from' && s.startsWith('.')) {
      // relative import: count leading dots
      const dotMatch = s.match(/^\.+/);
      const dots = dotMatch ? dotMatch[0].length : 1;
      const parts = fromFile.split('/');
      const baseParts = parts.slice(0, parts.length - dots);
      s = baseParts.join('/') + (baseParts.length ? '/' : '') + s.slice(dots).replace(/\./g, '/');
    } else {
      s = s.replace(/\./g, '/');
    }
    const candidates = [s + '.py', s + '.pyi', s + '/__init__.py', s];
    for (const c of candidates) if (this.fileSet.has(c)) return { file: c };
    // maybe relative to file dir
    const dir = path.posix.dirname(fromFile);
    for (const c of [dir + '/' + s + '.py', dir + '/' + s + '/__init__.py']) if (this.fileSet.has(c)) return { file: c };
    return { external: packageName(source.replace(/\./g, '/')) };
  }

  resolveGeneric(fromFile, source) {
    if (source.startsWith('.') || source.startsWith('/')) {
      const baseDir = path.posix.dirname(fromFile);
      const joined = source.startsWith('/') ? source.slice(1) : path.posix.normalize(path.posix.join(baseDir, source));
      const ext = path.posix.extname(joined);
      const candidates = [joined, joined + '.html', joined + '.css', joined + '.js', joined + '.ts', joined + '.vue', joined + '.svelte', joined + '.json', joined + '.md'];
      for (const c of candidates) if (this.fileSet.has(c)) return { file: c };
      return { unresolved: true };
    }
    return { external: source };
  }

  resolve(fromFile, imp) {
    const src = imp.source || '';
    const lang = this.langOf(fromFile);
    if (lang === 'python') return this.resolvePython(fromFile, src, imp.kind);
    if (['javascript', 'typescript', 'vue', 'svelte'].includes(lang) || /\.(jsx?|tsx?|mjs|cjs)$/.test(fromFile)) return this.resolveJs(fromFile, src);
    if (src.startsWith('.') || src.startsWith('/')) return this.resolveGeneric(fromFile, src);
    if (lang === 'go') {
      // try in-project module path match
      const norm = src.replace(/\./g, '/');
      for (const f of this.fileSet) if (f.startsWith(norm) || f.includes('/' + norm + '/')) return { file: f };
      return { external: src };
    }
    if (lang === 'java' || lang === 'csharp' || lang === 'php' || lang === 'rust' || lang === 'cpp') {
      return { external: src };
    }
    return this.resolveGeneric(fromFile, src);
  }

  langOf(file) {
    return this.filesLang?.get(file);
  }

  setLangs(files) {
    this.filesLang = new Map();
    for (const [p, f] of files) this.filesLang.set(p, f.lang);
  }
}
