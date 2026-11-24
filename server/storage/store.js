import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, CACHE_DIR, HISTORY_DIR, PROJECTS_FILE, AI_CONFIG_FILE, PARSER_VERSION, ensureDirs } from '../config.js';
import { hashString } from '../utils.js';

ensureDirs();

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

export function projectKey(rootPath) {
  return hashString(path.resolve(rootPath)).slice(0, 16);
}

export function listProjects() {
  return readJson(PROJECTS_FILE, []);
}

export function saveProjects(projects) {
  writeJson(PROJECTS_FILE, projects);
}

export function getProject(id) {
  return listProjects().find((p) => p.id === id) || null;
}

export function addProject(rootPath, name) {
  const projects = listProjects();
  const abs = path.resolve(rootPath);
  const existing = projects.find((p) => p.rootPath === abs);
  if (existing) return existing;
  const p = { id: projectKey(abs), name: name || path.basename(abs), rootPath: abs, addedAt: Date.now(), lastScanAt: null };
  projects.push(p);
  saveProjects(projects);
  return p;
}

export function removeProject(id) {
  const projects = listProjects().filter((p) => p.id !== id);
  saveProjects(projects);
}

export function updateProject(id, patch) {
  const projects = listProjects();
  const p = projects.find((x) => x.id === id);
  if (p) Object.assign(p, patch);
  saveProjects(projects);
  return p;
}

// ---- analysis cache ----
export function loadCache(rootPath) {
  const file = path.join(CACHE_DIR, projectKey(rootPath) + '.json');
  const data = readJson(file, null);
  if (!data || data.version !== PARSER_VERSION) return { version: PARSER_VERSION, files: {} };
  return data;
}

export function saveCache(rootPath, cache) {
  const file = path.join(CACHE_DIR, projectKey(rootPath) + '.json');
  writeJson(file, cache);
}

// ---- history ----
export function historyDir(projectId) {
  const d = path.join(HISTORY_DIR, projectId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function listHistory(projectId) {
  const d = path.join(HISTORY_DIR, projectId);
  try {
    return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => {
      const full = path.join(d, f);
      const st = fs.statSync(full);
      return { file: f, ts: Number(f.replace('.json', '')), size: st.size, at: st.mtimeMs };
    }).sort((a, b) => b.ts - a.ts);
  } catch { return []; }
}

export function saveHistorySnapshot(projectId, snapshot) {
  const ts = Date.now();
  writeJson(path.join(historyDir(projectId), ts + '.json'), { ...snapshot, ts });
  return ts;
}

export function loadHistorySnapshot(projectId, ts) {
  return readJson(path.join(HISTORY_DIR, projectId, ts + '.json'), null);
}

// ---- AI config ----
export function loadAiConfig() {
  return readJson(AI_CONFIG_FILE, { provider: 'openai', endpoint: '', apiKey: '', model: '', enabled: false });
}

export function saveAiConfig(cfg) {
  writeJson(AI_CONFIG_FILE, cfg);
}
