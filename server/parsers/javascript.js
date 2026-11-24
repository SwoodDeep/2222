import ts from 'typescript';
import { registerParser } from './registry.js';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'all', 'use']);
const NETWORK_FNS = new Set(['fetch', 'axios', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'http', 'https', 'grpc', 'request']);

function posOf(sf, node) {
  const { line } = ts.getLineAndCharacterOfPosition(sf, node.getStart(sf));
  return line + 1;
}

function endOf(sf, node) {
  const { line } = ts.getLineAndCharacterOfPosition(sf, node.getEnd());
  return line + 1;
}

function textOf(sf, node) {
  return node ? node.getText(sf) : '';
}

function calleeName(node) {
  if (!node) return null;
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isCallExpression(node)) return calleeName(node.expression);
  return null;
}

function stringArg(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function cyclomatic(node) {
  let c = 1;
  const visit = (n) => {
    if (
      ts.isIfStatement(n) || ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n) ||
      ts.isWhileStatement(n) || ts.isDoStatement(n) || ts.isCaseClause(n) || ts.isCatchClause(n) ||
      ts.isConditionalExpression(n)
    ) c++;
    else if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || n.operatorToken.kind === ts.SyntaxKind.BarBarToken)) c++;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return c;
}

function parseSource(filePath, text) {
  const isTS = /\.(tsx?|mts|cts)$/.test(filePath);
  const isJSX = /\.(jsx|tsx)$/.test(filePath);
  const sf = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    false,
    isTS ? (isJSX ? ts.ScriptKind.TSX : ts.ScriptKind.TS) : (isJSX ? ts.ScriptKind.JSX : ts.ScriptKind.JS)
  );

  const facts = {
    symbols: [], imports: [], exports: [], calls: [], classes: [], routes: [], network: [], db: [], events: [], components: [],
  };

  const addCall = (name, line) => { if (name) facts.calls.push({ name, line }); };

  const visit = (node) => {
    // imports
    if (ts.isImportDeclaration(node)) {
      const source = stringArg(node.moduleSpecifier);
      const specifiers = [];
      const clause = node.importClause;
      if (clause) {
        if (clause.name) specifiers.push({ imported: 'default', local: clause.name.text });
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) specifiers.push({ imported: '*', local: clause.namedBindings.name.text });
          else for (const el of clause.namedBindings.elements) specifiers.push({ imported: el.propertyName ? el.propertyName.text : el.name.text, local: el.name.text });
        }
      }
      facts.imports.push({ source, kind: 'import', specifiers, line: posOf(sf, node), dynamic: false });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const source = stringArg(node.moduleSpecifier);
      const specifiers = (node.exportClause && ts.isNamedExports(node.exportClause))
        ? node.exportClause.elements.map((el) => ({ imported: el.propertyName ? el.propertyName.text : el.name.text, local: el.name.text }))
        : [{ imported: '*', local: '*' }];
      facts.imports.push({ source, kind: 're-export', specifiers, line: posOf(sf, node), dynamic: false });
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = calleeName(node.expression);
      const line = posOf(sf, node);
      addCall(name, line);
      // require('x')
      if (name === 'require' && node.arguments.length) {
        const source = stringArg(node.arguments[0]);
        if (source) facts.imports.push({ source, kind: 'require', specifiers: [{ imported: '*', local: '*' }], line, dynamic: false });
      }
      // import('x')
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length) {
        const source = stringArg(node.arguments[0]);
        if (source) facts.imports.push({ source, kind: 'import', specifiers: [{ imported: '*', local: '*' }], line, dynamic: true });
      }
      // express-style routes: app.get('/path', handler) / router.post(...)
      if (name && HTTP_METHODS.has(name.toLowerCase())) {
        const expr = node.expression;
        if (ts.isPropertyAccessExpression(expr)) {
          const recv = textOf(sf, expr.expression).split('.').pop();
          if (/^(app|router|server|api|route|fastify|koaRouter|slim)$/i.test(recv) || /router/i.test(recv)) {
            const p = stringArg(node.arguments[0]);
            const handlerNode = node.arguments[1];
            let handler = null;
            if (handlerNode) {
              if (ts.isIdentifier(handlerNode)) handler = handlerNode.text;
              else if (ts.isPropertyAccessExpression(handlerNode)) handler = handlerNode.name.text;
            }
            if (p) facts.routes.push({ method: name.toUpperCase() === 'USE' ? 'USE' : name.toUpperCase(), path: p, handler, line, framework: 'express-like' });
          }
        }
      }
      // network
      if (name === 'fetch' || name === 'get' || name === 'post' || name === 'put' || name === 'del' || name === 'patch') {
        const expr = node.expression;
        const recv = ts.isPropertyAccessExpression(expr) ? textOf(sf, expr.expression) : '';
        if (name === 'fetch' || /axios/i.test(recv)) {
          const url = stringArg(node.arguments[0]) || (node.arguments[1] && stringArg(node.arguments[1].url ?? node.arguments[1])) || null;
          facts.network.push({ kind: 'http', url, method: name === 'fetch' ? 'GET' : name.toUpperCase(), line });
        }
      }
      if (name === 'WebSocket' || name === 'EventSource') {
        const url = stringArg(node.arguments[0]);
        facts.network.push({ kind: name === 'WebSocket' ? 'websocket' : 'sse', url, line });
      }
      if (name === 'open' && ts.isPropertyAccessExpression(node.expression)) {
        const args = node.arguments.map((a) => stringArg(a)).filter(Boolean);
        if (args.length >= 2) facts.network.push({ kind: 'http', url: args[1], method: args[0], line });
      }
      // db
      if (/^(query|execute|raw|exec)$/.test(name || '')) facts.db.push({ kind: 'sql-call', detail: name, line });
      if (name && /^(find|findOne|save|insert|update|delete|aggregate|create|upsert|bulkWrite)$/.test(name)) {
        const recv = ts.isPropertyAccessExpression(node.expression) ? textOf(sf, node.expression.expression) : '';
        if (recv) facts.db.push({ kind: 'orm', detail: recv + '.' + name, line });
      }
      // events
      if (name === 'addEventListener' || name === 'on' || name === 'emit' || name === 'subscribe' || name === 'once') {
        const arg = stringArg(node.arguments[0]);
        if (arg) facts.events.push({ kind: name, name: arg, line });
      }
    }

    // functions
    if (ts.isFunctionDeclaration(node) && node.name) {
      facts.symbols.push({ name: node.name.text, kind: 'function', line: posOf(sf, node), endLine: endOf(sf, node), signature: textOf(sf, node).split('{')[0].slice(0, 160), complexity: cyclomatic(node) });
    } else if (ts.isClassDeclaration(node) && node.name) {
      const extendsClause = node.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
      const extendsName = extendsClause?.types?.[0] ? textOf(sf, extendsClause.types[0].expression) : null;
      const methods = [];
      for (const m of node.members) {
        if (ts.isMethodDeclaration(m) && m.name) {
          const mn = ts.isIdentifier(m.name) ? m.name.text : textOf(sf, m.name);
          methods.push({ name: mn, line: posOf(sf, m), complexity: cyclomatic(m) });
        }
      }
      facts.classes.push({ name: node.name.text, extends: extendsName, line: posOf(sf, node), methods });
      facts.symbols.push({ name: node.name.text, kind: 'class', line: posOf(sf, node), endLine: endOf(sf, node), signature: 'class ' + node.name.text + (extendsName ? ' extends ' + extendsName : ''), complexity: methods.reduce((a, m) => a + (m.complexity || 1), 0) });
    } else if (ts.isInterfaceDeclaration(node)) {
      facts.symbols.push({ name: node.name.text, kind: 'interface', line: posOf(sf, node), endLine: endOf(sf, node), signature: textOf(sf, node).split('{')[0].slice(0, 120) });
    } else if (ts.isTypeAliasDeclaration(node)) {
      facts.symbols.push({ name: node.name.text, kind: 'type', line: posOf(sf, node), endLine: endOf(sf, node), signature: textOf(sf, node).split('=')[0].slice(0, 120) });
    } else if (ts.isEnumDeclaration(node)) {
      facts.symbols.push({ name: node.name.text, kind: 'enum', line: posOf(sf, node), endLine: endOf(sf, node), signature: 'enum ' + node.name.text });
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;
        const init = decl.initializer;
        const line = posOf(sf, node);
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          const kind = /^[A-Z]/.test(name) && (isJSX || /\.(vue|svelte)$/.test('')) ? 'component' : 'function';
          facts.symbols.push({ name, kind, line, endLine: endOf(sf, decl), signature: textOf(sf, decl).split('=>')[0].split('{')[0].slice(0, 160), complexity: cyclomatic(init) });
          if (kind === 'component') facts.components.push({ name, line });
        } else if (init && ts.isCallExpression(init) && /^[A-Z]/.test(name) && /createElement|jsx|h\(/.test(textOf(sf, init))) {
          facts.symbols.push({ name, kind: 'component', line, endLine: endOf(sf, decl), signature: name });
          facts.components.push({ name, line });
        } else {
          facts.symbols.push({ name, kind: 'variable', line, endLine: endOf(sf, decl), signature: name + (init ? ' = …' : '') });
        }
      }
    }

    // exports
    if (ts.isExportDeclaration(node) && !node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) facts.exports.push({ name: el.name.text, kind: 'named', line: posOf(sf, node) });
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node) || ts.isVariableStatement(node)) && hasExportModifier(node)) {
      if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) if (ts.isIdentifier(d.name)) facts.exports.push({ name: d.name.text, kind: 'named', line: posOf(sf, node) });
      } else if (node.name) facts.exports.push({ name: node.name.text, kind: 'named', line: posOf(sf, node) });
    }
    if (ts.isExportAssignment(node)) {
      facts.exports.push({ name: 'default', kind: 'default', line: posOf(sf, node) });
    }

    // react components: capitalized function declarations in jsx/tsx files
    if (isJSX && ts.isFunctionDeclaration(node) && node.name && /^[A-Z]/.test(node.name.text)) {
      if (!facts.components.find((c) => c.name === node.name.text)) {
        facts.components.push({ name: node.name.text, line: posOf(sf, node) });
        const sym = facts.symbols.find((s) => s.name === node.name.text && s.kind === 'function');
        if (sym) sym.kind = 'component';
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return facts;
}

function hasExportModifier(node) {
  return !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function parse(file, text) {
  try {
    return parseSource(file.path, text);
  } catch {
    return { symbols: [], imports: [], exports: [], calls: [], classes: [], routes: [], network: [], db: [], events: [], components: [] };
  }
}

registerParser('javascript', ['.js', '.mjs', '.cjs', '.jsx'], [], parse);
registerParser('typescript', ['.ts', '.tsx', '.mts', '.cts'], [], parse);
