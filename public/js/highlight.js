import hljs from '/vendor/hljs/es/core.js';
import javascript from '/vendor/hljs/es/languages/javascript.js';
import typescript from '/vendor/hljs/es/languages/typescript.js';
import python from '/vendor/hljs/es/languages/python.js';
import java from '/vendor/hljs/es/languages/java.js';
import go from '/vendor/hljs/es/languages/go.js';
import rust from '/vendor/hljs/es/languages/rust.js';
import csharp from '/vendor/hljs/es/languages/csharp.js';
import php from '/vendor/hljs/es/languages/php.js';
import css from '/vendor/hljs/es/languages/css.js';
import xml from '/vendor/hljs/es/languages/xml.js';
import json from '/vendor/hljs/es/languages/json.js';
import yaml from '/vendor/hljs/es/languages/yaml.js';
import sql from '/vendor/hljs/es/languages/sql.js';
import bash from '/vendor/hljs/es/languages/bash.js';
import markdown from '/vendor/hljs/es/languages/markdown.js';
import cpp from '/vendor/hljs/es/languages/cpp.js';
import diff from '/vendor/hljs/es/languages/diff.js';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('java', java);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('php', php);
hljs.registerLanguage('css', css);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('diff', diff);

const MAP = {
  javascript: 'javascript', typescript: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  python: 'python', java: 'java', go: 'go', rust: 'rust', csharp: 'csharp', php: 'php', cpp: 'cpp', c: 'cpp',
  css: 'css', scss: 'css', less: 'css', html: 'html', vue: 'xml', svelte: 'xml',
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', sql: 'sql', shell: 'bash', sh: 'bash', md: 'markdown', markdown: 'markdown',
};

export function langFor(langId, path) {
  if (MAP[langId]) return MAP[langId];
  const ext = (path || '').split('.').pop();
  return MAP[ext] || 'plaintext';
}

export function highlight(code, lang) {
  try {
    return hljs.highlight(code, { language: lang }).value;
  } catch {
    return code.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }
}
