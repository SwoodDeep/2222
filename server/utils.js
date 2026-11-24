import fs from 'node:fs';
import crypto from 'node:crypto';

export function relPath(root, abs) {
  return abs.split('/').slice(root.split('/').length).join('/') || '.';
}

export function isBinaryBuffer(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export async function readTextFile(abs, maxBytes) {
  const fh = await fs.promises.open(abs, 'r');
  try {
    const stat = await fh.stat();
    const size = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(size);
    await fh.read(buf, 0, size, 0);
    if (isBinaryBuffer(buf)) return null;
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

export function countLines(text) {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

export function hashString(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

export function shingles(text, n = 6) {
  const lines = text.split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).filter((l) => l.length > 2 && !l.startsWith('//') && !l.startsWith('#') && !l.startsWith('/*') && !l.startsWith('*'));
  const out = [];
  for (let i = 0; i + n <= lines.length; i++) {
    out.push(hashString(lines.slice(i, i + n).join('\n')));
  }
  return out;
}

export function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function normalizeRoutePath(p) {
  if (!p) return '';
  return String(p)
    .replace(/^['"`]|['"`]$/g, '')
    .replace(/\/:[^/]+/g, '/{}')
    .replace(/\{\{?\w+\}?\}/g, '{}')
    .replace(/<[^>]+>/g, '{}')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '') || '/';
}

export function routeSimilarity(a, b) {
  const na = normalizeRoutePath(a);
  const nb = normalizeRoutePath(b);
  if (na === nb) return 1;
  const sa = na.split('/').filter(Boolean);
  const sb = nb.split('/').filter(Boolean);
  if (sa.length !== sb.length) return 0;
  let match = 0;
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] === sb[i] || sa[i] === '{}' || sb[i] === '{}') match++;
  }
  return match / sa.length;
}

export class Emitter {
  constructor() { this.listeners = new Map(); }
  on(evt, fn) {
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    this.listeners.get(evt).add(fn);
    return () => this.listeners.get(evt)?.delete(fn);
  }
  emit(evt, data) {
    for (const fn of this.listeners.get(evt) || []) {
      try { fn(data); } catch { /* listener errors must not break scan */ }
    }
  }
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
