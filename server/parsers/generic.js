import { registerParser } from './registry.js';

// Fallback for any other text file: extract obvious symbols with common patterns.
function parseGeneric(file, text) {
  const facts = { symbols: [], imports: [], exports: [], calls: [], classes: [], routes: [], network: [], db: [], events: [], components: [] };
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    let m;
    if ((m = line.match(/^\s*(?:async\s+)?function\s+(\w+)|^\s*def\s+(\w+)|^\s*(?:export\s+)?class\s+(\w+)/))) {
      facts.symbols.push({ name: m[1] || m[2] || m[3], kind: 'function', line: i + 1, endLine: i + 1, signature: line.trim().slice(0, 120) });
    }
  });
  return facts;
}

registerParser('generic', ['.rb', '.swift', '.lua', '.r', '.scala', '.ex', '.exs', '.erl', '.hs', '.clj', '.fs'], [], parseGeneric);
