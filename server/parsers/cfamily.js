import { registerParser } from './registry.js';

const CONFIGS = {
  java: {
    exts: ['.java', '.kt'],
    importRe: /^\s*import\s+(static\s+)?([\w\.]+)(\.\*)?\s*;/,
    packageRe: /^\s*package\s+([\w\.]+)\s*;/,
    classRe: /^\s*(?:public|private|protected|abstract|final|static|\s)*class\s+(\w+)(?:\s+extends\s+([\w\.]+))?(?:\s+implements\s+([\w\.,\s]+?))?\s*\{/,
    funcRe: /^\s*(?:public|private|protected|static|final|synchronized|abstract|default|\s)+[\w<>\[\],\s\.]+?\s+(\w+)\s*\(([^)]*)\)\s*(?:throws[\w\s,.]+)?\s*\{/,
    routeRe: /@(Get|Post|Put|Delete|Patch|Request)Mapping\(\s*(?:value\s*=\s*)?["'`]([^"'`]+)["'`](?:\s*,\s*method\s*=\s*RequestMethod\.(\w+))?/g,
    routeRe2: /@(Get|Post|Put|Delete|Patch)Mapping\(\s*["'`]([^"'`]+)["'`]/g,
    networkRe: /\b(new\s+(RestTemplate|WebClient|HttpClient|WebSocket|OkHttpClient)|HttpClient\.newHttpClient\(\))/,
    dbRe: /\b(JdbcTemplate|EntityManager|SessionFactory|Hibernate|@Repository|@Entity|@Table|CriteriaBuilder)\b/,
    eventRe: /@EventListener|\.addEventListener\(|\.addListener\(|\.addHandler\(/,
    callRe: /\b([A-Za-z_]\w*)\s*\(/g,
    keywords: new Set(['if', 'for', 'while', 'new', 'return', 'switch', 'case', 'catch', 'throw', 'else', 'do', 'try', 'class', 'interface', 'enum', 'import', 'package', 'extends', 'implements', 'public', 'private', 'protected', 'static', 'void', 'int', 'long', 'boolean', 'String', 'var', 'val']),
  },
  csharp: {
    exts: ['.cs'],
    importRe: /^\s*using\s+(?:static\s+)?([\w\.]+)\s*(?:=|;)/,
    packageRe: /^\s*namespace\s+([\w\.]+)/,
    classRe: /^\s*(?:public|private|protected|internal|abstract|sealed|static|partial|\s)*class\s+(\w+)(?:\s*:\s*([\w\.,\s<>]+?))?\s*[{:]/,
    funcRe: /^\s*(?:public|private|protected|internal|static|virtual|override|async|sealed|abstract|\s)+[\w<>\[\],\?\.]+\s+(\w+)\s*\(([^)]*)\)\s*(?:where[\s\S]+?)?\{/,
    routeRe: /\[(?:Http)?(Get|Post|Put|Delete|Patch)\(\s*["'`]([^"'`]+)["'`]\s*\)\]|\[Route\(\s*["'`]([^"'`]+)["'`]/g,
    networkRe: /\b(new\s+(HttpClient|WebSocket|ClientWebSocket)|HttpClient|WebClient|SocketsHttpHandler)/,
    dbRe: /\b(DbContext|DbSet<|EntityFramework|SqlConnection|SqlCommand|Dapper|Npgsql|EntityFrameworkCore|IConfiguration)\b/,
    eventRe: /\.Subscribe\(|\+=\s*\w+|\.on\(|AddEventListener|EventHandler</,
    callRe: /\b([A-Za-z_]\w*)\s*\(/g,
    keywords: new Set(['if', 'for', 'foreach', 'while', 'new', 'return', 'switch', 'case', 'catch', 'using', 'namespace', 'class', 'void', 'var', 'get', 'set', 'async', 'await']),
  },
  go: {
    exts: ['.go'],
    importRe: /^\s*(?:import\s+)?(?:\w+\s+)?["`]([\w\.\-/]+)["`]/,
    packageRe: /^\s*package\s+(\w+)/,
    classRe: /^type\s+(\w+)\s+(?:struct|interface)\s*\{/,
    funcRe: /^func\s*(?:\([^)]*\)\s*)?(\w+)\s*\(([^)]*)\)/,
    routeRe: /\b(?:http\.)?HandleFunc\(\s*["`]([^"`]+)["`]\s*,\s*(\w+)|(?:mux|gin|echo|router)\.(\w+)\(\s*["`]([^"`]+)["`]/g,
    networkRe: /\b(http\.(Get|Post|NewRequest|DefaultClient)|websocket\.|net\.Dial|grpc\.Dial|resty\.)/,
    dbRe: /\b(sql\.Open|sqlx\.|gorm\.|pgx\.|database\/sql|mongo\.|redis\.|db\.Query|db\.Exec)\b/,
    eventRe: /\.on\(|\.Listen\(|http\.ListenAndServe/,
    callRe: /\b([A-Za-z_]\w*)\s*\(/g,
    keywords: new Set(['if', 'for', 'func', 'return', 'switch', 'case', 'go', 'chan', 'import', 'package', 'type', 'var', 'const', 'range', 'defer']),
  },
  rust: {
    exts: ['.rs'],
    importRe: /^\s*(?:pub\s+)?use\s+([\w:]+)(?:::([\w:{},\s*]+))?\s*;/,
    packageRe: null,
    classRe: /^\s*(?:pub\s+)?(?:struct|enum|trait|impl)(?:<[^>]*>)?\s+(\w+)(?:\s+where[\s\S]+?)?\s*\{/,
    funcRe: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/,
    routeRe: /#\[(get|post|put|delete|patch)\(\s*"([^"]+)"\s*\)\]/g,
    networkRe: /\b(reqwest::|hyper::|awc::|tokio_tungstenite|websocket|tonic::)/,
    dbRe: /\b(sqlx::|diesel::|sea_orm|rusqlite|tokio_postgres|mongodb::|redis::)/,
    eventRe: /\.on\(|\.listen\(|\.subscribe\(/,
    callRe: /\b([A-Za-z_]\w*)\s*[!(<]/g,
    keywords: new Set(['if', 'for', 'while', 'match', 'fn', 'let', 'return', 'use', 'mod', 'struct', 'enum', 'impl', 'loop', 'in', 'mut']),
  },
  php: {
    exts: ['.php'],
    importRe: /^\s*(?:use\s+(?:function\s+)?|namespace\s+)([\w\\]+)\s*;/,
    packageRe: /^\s*namespace\s+([\w\\]+)\s*;/,
    classRe: /^\s*(?:abstract\s+|final\s+)?class\s+(\w+)(?:\s+extends\s+([\w\\]+))?(?:\s+implements\s+([\w\\,\s]+))?\s*\{/,
    funcRe: /^\s*(?:public|private|protected|static|abstract|\s)*(?:function\s+)?(\w+)\s*\(([^)]*)\)\s*\{/,
    routeRe: /(?:Route::(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"]|\$app->(get|post|put|delete)\(\s*['"`]([^'"`]+)['"])/g,
    networkRe: /\b(curl_|file_get_contents|GuzzleHttp|fsockopen|new\s+SoapClient)/,
    dbRe: /\b(PDO|mysqli|DB::|Eloquent|\$conn->|prepare\(|execute\(|Doctrine)/,
    eventRe: /->on\(|addEventListener|->listen\(/,
    callRe: /\b([A-Za-z_]\w*)\s*\(/g,
    keywords: new Set(['if', 'for', 'foreach', 'while', 'function', 'return', 'new', 'use', 'class', 'echo', 'require', 'include']),
  },
  cpp: {
    exts: ['.c', '.h', '.cpp', '.hpp', '.cc', '.cxx'],
    importRe: /^\s*#\s*include\s*[<"]([^>"]+)[>"]/,
    packageRe: null,
    classRe: /^\s*(?:class|struct)\s+(\w+)(?:\s*:\s*[\w\s,:]+)?\s*\{/,
    funcRe: /^\s*[\w:~*&<>]+\s+(\w+)\s*\(([^)]*)\)\s*(?:const)?\s*\{/,
    routeRe: null,
    networkRe: /\b(curl_easy|boost::asio|socket\(|WinHttp|libpq|sqlite3_)/,
    dbRe: /\b(sqlite3_|PQexec|mysql_query|pqxx|soci::|libpq-fe)/,
    eventRe: /\.on\(|connect\(|signal\(/,
    callRe: /\b([A-Za-z_]\w*)\s*\(/g,
    keywords: new Set(['if', 'for', 'while', 'return', 'new', 'switch', 'case', 'catch', 'class', 'struct', 'include', 'namespace', 'template']),
  },
};

function complexityInBlock(lines, startIdx, openIndent) {
  let c = 1;
  const braceRe = /[{}<>]/;
  for (let i = startIdx + 1; i < Math.min(lines.length, startIdx + 400); i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (/\b(if|for|while|switch|catch)\b/.test(t)) c++;
    if (/\bcase\b/.test(t)) c++;
    if (/\?[^:]/.test(t) && /:/.test(t)) c++;
    if (/&&|\|\|/.test(t)) c++;
    if (braceRe && t === '}') break;
  }
  return c;
}

function parseWith(cfg, file, text) {
  const lines = text.split('\n');
  const facts = { symbols: [], imports: [], exports: [], calls: [], classes: [], routes: [], network: [], db: [], events: [], components: [] };
  let currentClass = null;
  let pendingRoutes = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;
    let m;
    if (cfg.importRe && (m = line.match(cfg.importRe))) {
      const src = m[2] || m[1];
      if (src && !src.startsWith('java.lang')) facts.imports.push({ source: src, kind: 'import', specifiers: [{ imported: '*', local: '*' }], line: ln, dynamic: false });
      continue;
    }
    if (cfg.packageRe && (m = line.match(cfg.packageRe))) {
      facts.symbols.push({ name: m[1].split('.').pop(), kind: 'package', line: ln, endLine: ln, signature: m[1] });
      continue;
    }
    if (cfg.classRe && (m = line.match(cfg.classRe))) {
      currentClass = m[1];
      facts.classes.push({ name: m[1], extends: m[2] || null, line: ln, methods: [] });
      facts.symbols.push({ name: m[1], kind: cfg === CONFIGS.go || cfg === CONFIGS.rust ? 'type' : 'class', line: ln, endLine: ln, signature: line.trim().slice(0, 140) });
      continue;
    }
    if (cfg.funcRe && (m = line.match(cfg.funcRe))) {
      const name = m[1];
      if (name && !cfg.keywords.has(name)) {
        facts.symbols.push({ name, kind: 'function', line: ln, endLine: ln, signature: line.trim().slice(0, 160), complexity: complexityInBlock(lines, i) });
        facts.exports.push({ name, kind: 'named', line: ln });
        if (currentClass) {
          const cls = facts.classes.find((c) => c.name === currentClass);
          if (cls) cls.methods.push({ name, line: ln, complexity: complexityInBlock(lines, i) });
        }
      }
    }
    if (cfg.routeRe) {
      cfg.routeRe.lastIndex = 0;
      let rm;
      while ((rm = cfg.routeRe.exec(line))) {
        const groups = rm.slice(1).filter(Boolean);
        let method = null, p = null, handler = null;
        if (cfg === CONFIGS.java) {
          method = (rm[2] || rm[1] || 'REQUEST').toUpperCase();
          p = rm[3] || rm[1];
        } else if (cfg === CONFIGS.csharp) {
          method = (rm[1] || 'GET').toUpperCase(); p = rm[2] || rm[3];
        } else if (cfg === CONFIGS.go) {
          p = rm[1] || rm[4]; method = 'GET'; handler = rm[2];
        } else if (cfg === CONFIGS.rust) {
          method = rm[1].toUpperCase(); p = rm[2];
        } else if (cfg === CONFIGS.php) {
          method = (rm[1] || rm[3] || 'GET').toUpperCase(); p = rm[2] || rm[4];
        }
        if (p) facts.routes.push({ method, path: p, handler, line: ln, framework: Object.keys(CONFIGS).find((k) => CONFIGS[k] === cfg) });
      }
    }
    if (cfg.networkRe?.test(line)) {
      const urlM = line.match(/["'`](https?:\/\/[^"'`]+|wss?:\/\/[^"'`]+|\/[^"'` ]{2,80})["'`]/);
      facts.network.push({ kind: /websocket|ws/i.test(line) ? 'websocket' : 'http', url: urlM ? urlM[1] : null, method: 'GET', line: ln });
    }
    if (cfg.dbRe?.test(line)) facts.db.push({ kind: 'db', detail: line.trim().slice(0, 140), line: ln });
    if (cfg.eventRe?.test(line)) {
      const evM = line.match(/["'`]([\w\-:.]+)["'`]/);
      facts.events.push({ kind: 'event', name: evM ? evM[1] : 'handler', line: ln });
    }
    cfg.callRe.lastIndex = 0;
    let cm;
    while ((cm = cfg.callRe.exec(line))) {
      if (!cfg.keywords.has(cm[1])) facts.calls.push({ name: cm[1], line: ln });
    }
  }
  return facts;
}

for (const [id, cfg] of Object.entries(CONFIGS)) {
  registerParser(id, cfg.exts, [], (file, text) => parseWith(cfg, file, text));
}
