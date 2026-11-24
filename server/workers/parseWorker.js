import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import { parseFile } from '../parsers/index.js';
import { isBinaryBuffer, shingles } from '../utils.js';
import { SECRET_LINE_RE } from '../config.js';

parentPort.on('message', async ({ jobId, files }) => {
  const results = [];
  for (const file of files) {
    try {
      if (!file.parseable) {
        results.push({ path: file.path, skipped: true, reason: 'too-large' });
        continue;
      }
      let text = null;
      try {
        const buf = await fs.promises.readFile(file.abs);
        if (isBinaryBuffer(buf)) { results.push({ path: file.path, skipped: true, reason: 'binary' }); continue; }
        text = buf.toString('utf8');
      } catch (e) {
        results.push({ path: file.path, skipped: true, reason: 'unreadable' });
        continue;
      }
      const facts = parseFile(file, text);
      facts.mtimeMs = file.mtimeMs;
      // heavy derivations computed here so raw text never leaves the worker
      const capped = text.length > 500_000 ? text.slice(0, 500_000) : text;
      const lines = capped.split('\n');
      facts.shingleHashes = lines.length > 4000 ? shingles(lines.slice(0, 4000).join('\n'), 6) : shingles(capped, 6);
      let sec = 0;
      for (const line of lines) { if (SECRET_LINE_RE.test(line)) sec++; if (sec > 5) break; }
      facts.secretLineCount = sec;
      results.push({ path: file.path, facts });
    } catch (e) {
      results.push({ path: file.path, skipped: true, reason: 'error:' + (e.message || '').slice(0, 80) });
    }
  }
  parentPort.postMessage({ jobId, results });
});
