// Central client-side state + tiny event bus + persisted settings.
const listeners = new Map();

export const state = {
  projects: [],
  project: null,          // current project object
  graph: null,            // {nodes, edges, clusters, routes, stats, risks}
  tree: null,
  selected: null,         // node id
  selectedSymbol: null,
  view: 'brain',
  hiddenCategories: new Set(),
  impact: null,           // impact result
  settings: loadSettings(),
  scanning: false,
};

function loadSettings() {
  try {
    return { leftW: 280, rightW: 340, bottomH: 220, bottomOpen: false, accent: '#58a6ff', ...JSON.parse(localStorage.getItem('codebrain-settings') || '{}') };
  } catch { return { leftW: 280, rightW: 340, bottomH: 220, bottomOpen: false, accent: '#58a6ff' }; }
}
export function saveSettings() {
  localStorage.setItem('codebrain-settings', JSON.stringify(state.settings));
}

export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt).delete(fn);
}
export function emit(evt, data) {
  for (const fn of listeners.get(evt) || []) { try { fn(data); } catch (e) { console.error(e); } }
}

export const CATEGORY_COLORS = {
  frontend: '#4cc2ff',
  backend: '#ffb454',
  api: '#c792ea',
  database: '#82aaff',
  service: '#7fdbca',
  config: '#8b949e',
  test: '#6e7681',
  docs: '#d2a8ff',
  external: '#f778ba',
  virtual: '#ff7b72',
  other: '#adbac7',
};
export const CATEGORY_LABELS = {
  frontend: 'Frontend', backend: 'Backend', api: 'API', database: 'БД', service: 'Сервисы',
  config: 'Конфиги', test: 'Тесты', docs: 'Документация', external: 'Внешние', virtual: 'Виртуальные', other: 'Прочее',
};
export const KIND_LABELS = { import: 'импорт', dependency: 'зависимость', call: 'вызов', extends: 'наследование', http: 'HTTP', websocket: 'WebSocket', db: 'БД', route: 'роут', event: 'событие', contains: 'содержит' };

export function nodeColor(n) {
  if (n.risk?.includes('secret')) return '#ff5555';
  if (n.risk?.includes('cycle')) return '#ff7b72';
  if (n.risk?.length) return '#f0883e';
  return CATEGORY_COLORS[n.category] || CATEGORY_COLORS.other;
}
