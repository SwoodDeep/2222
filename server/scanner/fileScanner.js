import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_IGNORE_DIRS, BINARY_EXTENSIONS, MAX_FILE_BYTES, MAX_FILES, MAX_WATCH_DIRS } from '../config.js';
import { isBinaryBuffer } from '../utils.js';

const SOURCE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.pyi', '.java', '.kt', '.kts', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.cs',
  '.php', '.rb', '.swift', '.html', '.htm', '.css', '.scss', '.less', '.sass',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.sql',
  '.md', '.txt', '.xml', '.vue', '.svelte', '.graphql', '.gql', '.prisma',
  '.sh', '.bash', '.ps1', '.bat', '.env', '.gitignore', '.dockerignore', '.editorconfig',
]);

const CONFIG_BASENAMES = new Set([
  'package.json', 'tsconfig.json', 'jsconfig.json', 'vite.config.js', 'vite.config.ts',
  'webpack.config.js', 'rollup.config.js', 'next.config.js', 'next.config.mjs', 'nuxt.config.ts',
  'angular.json', 'docker-compose.yml', 'docker-compose.yaml', 'Dockerfile', 'dockerfile',
  '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.prettierrc', '.babelrc', 'babel.config.js',
  'jest.config.js', 'vitest.config.ts', 'tailwind.config.js', 'tsconfig.json', 'pyproject.toml',
  'requirements.txt', 'Pipfile', 'setup.py', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle',
  'appsettings.json', 'composer.json', 'Gemfile', 'Makefile', '.env.example', '.env',
]);

function loadGitignore(root) {
  const ig = [];
  const files = ['.gitignore', path.join('.git', 'info', 'exclude')];
  for (const f of files) {
    try {
      const p = path.join(root, f);
      const content = fs.readFileSync(p, 'utf8');
      ig.push(parseGitignore(content, path.dirname(p) === root ? '' : path.dirname(p).slice(root.length + 1)));
    } catch { /* no gitignore */ }
  }
  return ig;
}

function parseGitignore(content, base) {
  const rules = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const neg = line.startsWith('!');
    const pat = neg ? line.slice(1) : line;
    const dirOnly = pat.endsWith('/');
    const clean = dirOnly ? pat.slice(0, -1) : pat;
    const anchored = clean.startsWith('/');
    const body = anchored ? clean.slice(1) : clean;
    rules.push({ neg, dirOnly, anchored, base, body, re: globToRe(body, dirOnly) });
  }
  return rules;
}

function globToRe(glob, dirOnly) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '/') re += '/';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  if (dirOnly) return new RegExp('(^|/)' + re + '(/|$)');
  return new RegExp('(^|/)' + re + '$');
}

function makeMatcher(root) {
  const ignoreRules = loadGitignore(root);
  return function isIgnored(absPath, isDir) {
    const rel = path.relative(root, absPath).split(path.sep).join('/');
    if (!rel) return false;
    const name = path.basename(absPath);
    if (isDir && DEFAULT_IGNORE_DIRS.has(name)) return true;
    if (!isDir && BINARY_EXTENSIONS.has(path.extname(name).toLowerCase())) return true;
    for (const group of ignoreRules) {
      for (const rule of group) {
        const target = rule.base ? rule.base + '/' + rel : rel;
        if (rule.re.test(target) || (!rule.dirOnly && rule.re.test(target.split('/').pop()))) {
          if (rule.neg) return false;
          return true;
        }
      }
    }
    return false;
  };
}

export async function scanFiles(root, onProgress) {
  const isIgnored = makeMatcher(root);
  const files = [];
  let scannedDirs = 0;
  const stack = [root];
  const visited = new Set();

  while (stack.length && files.length < MAX_FILES) {
    const dir = stack.pop();
    const real = await fs.promises.realpath(dir).catch(() => null);
    if (!real || visited.has(real)) continue;
    visited.add(real);
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch { continue; }
    scannedDirs++;
    if (scannedDirs % 200 === 0 && onProgress) onProgress({ phase: 'scanning', dirs: scannedDirs, files: files.length });
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      let isDir = e.isDirectory();
      let isSymlink = e.isSymbolicLink();
      if (isSymlink) {
        continue; // never follow symlinks out of the project
      }
      if (isIgnored(abs, isDir)) continue;
      if (isDir) {
        if (visited.size < MAX_WATCH_DIRS) stack.push(abs);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        const base = e.name;
        const isSource = SOURCE_EXTS.has(ext) || CONFIG_BASENAMES.has(base) || base === 'Dockerfile' || base === 'Makefile';
        if (!isSource) continue;
        let stat;
        try { stat = await fs.promises.stat(abs); } catch { continue; }
        if (!stat.isFile()) continue;
        const rel = path.relative(root, abs).split(path.sep).join('/');
        files.push({ path: rel, abs, size: stat.size, mtimeMs: stat.mtimeMs, parseable: stat.size <= MAX_FILE_BYTES });
      }
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export async function isBinaryFile(abs) {
  let fh;
  try { fh = await fs.promises.open(abs, 'r'); } catch { return true; }
  try {
    const buf = Buffer.alloc(8000);
    const { bytesRead } = await fh.read(buf, 0, 8000, 0);
    return isBinaryBuffer(buf.subarray(0, bytesRead));
  } finally { await fh.close(); }
}
