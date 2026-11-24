import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCAN_CONCURRENCY } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class ParsePool {
  constructor(size = SCAN_CONCURRENCY) {
    this.size = size;
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending = new Map();
    this.nextId = 1;
    for (let i = 0; i < size; i++) this.spawn();
  }

  spawn() {
    const w = new Worker(path.join(__dirname, 'parseWorker.js'));
    w.on('message', (msg) => {
      const { jobId, results } = msg;
      const resolve = this.pending.get(jobId);
      if (resolve) {
        this.pending.delete(jobId);
        resolve(results);
      }
      this.idle.push(w);
      this.pump();
    });
    w.on('error', () => {
      this.idle = this.idle.filter((x) => x !== w);
      this.spawn();
      this.pump();
    });
    this.workers.push(w);
    this.idle.push(w);
  }

  pump() {
    while (this.idle.length && this.queue.length) {
      const { files, resolve } = this.queue.shift();
      const w = this.idle.pop();
      const jobId = this.nextId++;
      this.pending.set(jobId, resolve);
      w.postMessage({ jobId, files });
    }
  }

  parseBatch(files) {
    return new Promise((resolve) => {
      this.queue.push({ files, resolve });
      this.pump();
    });
  }

  async parseAll(files, onProgress, batchSize = 40) {
    const results = [];
    let done = 0;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      const res = await this.parseBatch(batch);
      results.push(...res);
      done += batch.length;
      if (onProgress) onProgress(done, files.length);
    }
    return results;
  }

  terminate() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.idle = [];
  }
}
