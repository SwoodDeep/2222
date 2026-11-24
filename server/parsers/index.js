import './javascript.js';
import './python.js';
import './cfamily.js';
import './web.js';
import './dataformats.js';
import './generic.js';
import { getParserFor, emptyFacts, detectLanguage } from './registry.js';
import { countLines } from '../utils.js';

export function parseFile(file, text) {
  const parser = getParserFor(file.path);
  const lang = parser ? parser.id : 'text';
  const facts = parser ? parser.parse(file, text) : emptyFacts(file);
  facts.path = file.path;
  facts.lang = lang;
  facts.size = file.size;
  facts.loc = countLines(text);
  facts.hasSecrets = /\.env($|\.)/.test(file.path) || file.path.split('/').pop().startsWith('.env');
  return facts;
}

export { getParserFor, detectLanguage };
