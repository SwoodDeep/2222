import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const APP_NAME = 'codebrain';
export const DATA_DIR = process.env.CODEBRAIN_DATA_DIR || path.join(os.homedir(), '.codebrain');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const HISTORY_DIR = path.join(DATA_DIR, 'history');
export const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
export const AI_CONFIG_FILE = path.join(DATA_DIR, 'ai.json');
export const PORT = Number(process.env.PORT || 4173);
export const HOST = process.env.HOST || '127.0.0.1';

export const PARSER_VERSION = 7;

export const MAX_FILE_BYTES = 1_000_000;          // files larger are counted but not parsed
export const MAX_FILES = 200_000;
export const MAX_WATCH_DIRS = 20_000;
export const SCAN_CONCURRENCY = Math.max(2, (os.cpus() || []).length - 1);

export const DEFAULT_IGNORE_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'vendor',
  '__pycache__', '.venv', 'venv', 'env', '.env', 'envs',
  'dist', 'build', 'out', '.next', '.nuxt', '.output', 'coverage', '.nyc_output',
  'target', '.idea', '.vscode', '.gradle', 'bin', 'obj',
  '.terraform', '.serverless', 'tmp', 'temp', '.cache', '.parcel-cache',
  '.turbo', '.vercel', '.expo', 'Pods', 'DerivedData',
]);

export const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svgz', '.tiff',
  '.mp3', '.mp4', '.mov', '.avi', '.webm', '.wav', '.ogg', '.flac',
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.7z', '.rar', '.jar', '.war',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.pyc', '.pyo', '.class',
  '.o', '.a', '.wasm', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt',
  '.sqlite', '.db', '.mdb', '.lock', '.woff', '.woff2', '.ttf', '.eot', '.otf',
]);

export const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.pyi', '.java', '.kt', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cc', '.cs',
  '.php', '.rb', '.swift', '.html', '.htm', '.css', '.scss', '.less', '.sass',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.sql',
  '.md', '.markdown', '.txt', '.xml', '.vue', '.svelte', '.env.example', '.gitignore',
  '.dockerignore', 'Dockerfile', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.graphql', '.gql', '.prisma',
]);

export const SECRET_FILE_PATTERNS = [
  /(^|\/)\.env(\.|$)/i, /(^|\/)\.env\./i, /id_rsa/, /\.pem$/i, /\.key$/i,
  /credentials/i, /secrets?\.(json|ya?ml|toml|ini)$/i,
];

export const SECRET_LINE_RE =
  /(api[_-]?key|secret|secret[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret|password|passwd|pwd)\s*[:=]\s*["'`]?[A-Za-z0-9\/+\-_\.]{8,}["'`]?/i;

export function ensureDirs() {
  for (const d of [DATA_DIR, CACHE_DIR, HISTORY_DIR]) fs.mkdirSync(d, { recursive: true });
}

export function safeJoin(root, rel) {
  const resolved = path.resolve(root, rel);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return null;
  return resolved;
}
