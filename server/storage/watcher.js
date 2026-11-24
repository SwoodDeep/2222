import fs from 'node:fs';
import path from 'node:path';
import { MAX_WATCH_DIRS } from '../config.js';
import { debounce } from '../utils.js';

// Watches project directories (Linux fs.watch is not recursive, so watch each dir).
export class ProjectWatcher {
  constructor(root, onChange) {
    this.root = root;
    this.onChange = onChange;
    this.watchers = new Map();
    this.closed = false;
    this.trigger = debounce(() => {
      if (!this.closed) this.onChange();
    }, 600);
  }

  async start() {
    const stack = [this.root];
    const seen = new Set();
    while (stack.length && seen.size < MAX_WATCH_DIRS) {
      const dir = stack.pop();
      let real;
      try { real = await fs.promises.realpath(dir); } catch { continue; }
      if (seen.has(real)) continue;
      seen.add(real);
      try {
        const w = fs.watch(dir, { persistent: false }, (event, name) => {
          if (!name) return;
          this.trigger();
        });
        w.on('error', () => {});
        this.watchers.set(dir, w);
      } catch { continue; }
      let entries = [];
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.git') && !e.name.startsWith('.')) {
          stack.push(path.join(dir, e.name));
        }
      }
    }
  }

  close() {
    this.closed = true;
    for (const w of this.watchers.values()) { try { w.close(); } catch {} }
    this.watchers.clear();
  }
}
