import { CATEGORY_COLORS, CATEGORY_LABELS, on } from './state.js';

// Left-panel project tree with lazy expansion.
export class FileTree {
  constructor(host, { onSelect } = {}) {
    this.host = host;
    this.onSelect = onSelect;
    this.expanded = new Set(['']);
    this.selected = null;
    this.filter = '';
  }

  setData(tree, stats) {
    this.tree = tree;
    this.stats = stats;
    this.render();
  }

  matches(node) {
    if (!this.filter) return true;
    return node.path.toLowerCase().includes(this.filter) || (node.children || []).some((c) => this.matches(c));
  }

  render() {
    this.host.innerHTML = '';
    if (!this.tree) return;
    const frag = document.createDocumentFragment();
    this.renderNode(this.tree, frag, 0);
    this.host.appendChild(frag);
  }

  renderNode(node, host, depth) {
    if (node.type === 'dir') {
      const isOpen = this.expanded.has(node.path);
      const row = el('div', 'tree-row');
      row.style.paddingLeft = 6 + depth * 13 + 'px';
      row.innerHTML = `<span class="tw">${isOpen ? '▾' : '▸'}</span><span class="nm">${esc(node.name)}/</span><span class="meta">${(node.children || []).length}</span>`;
      row.onclick = () => {
        if (isOpen) this.expanded.delete(node.path); else this.expanded.add(node.path);
        this.render();
      };
      host.appendChild(row);
      if (isOpen) {
        const ch = el('div', 'tree-children');
        host.appendChild(ch);
        const kids = (node.children || []).filter((c) => this.matches(c));
        if (kids.length > 3000) kids.slice(0, 3000).forEach((c) => this.renderNode(c, ch, depth + 1));
        else kids.forEach((c) => this.renderNode(c, ch, depth + 1));
      }
    } else {
      const row = el('div', 'tree-row' + (this.selected === node.path ? ' selected' : ''));
      row.style.paddingLeft = 6 + depth * 13 + 'px';
      const color = CATEGORY_COLORS[node.category] || '#adbac7';
      row.innerHTML = `<span class="tw"></span><span style="width:7px;height:7px;border-radius:50%;background:${color};flex:0 0 auto"></span>` +
        `<span class="nm">${esc(node.name)}</span>` +
        (node.risks?.length ? `<span class="risk-dot" title="есть риски: ${node.risks.join(', ')}"></span>` : '') +
        `<span class="meta">${node.loc || 0}</span>`;
      row.title = `${node.path} · ${CATEGORY_LABELS[node.category] || node.category || ''} · ${node.lang || ''}`;
      row.onclick = () => { this.onSelect?.(node.path); };
      host.appendChild(row);
    }
  }

  select(path) {
    this.selected = path;
    // expand ancestors
    if (path) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) this.expanded.add(parts.slice(0, i).join('/'));
    }
    this.render();
    const row = [...this.host.querySelectorAll('.tree-row')].find((r) => r.title?.startsWith(path + ' '));
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  setFilter(f) { this.filter = f.toLowerCase(); this.render(); }
}

function el(tag, cls) { const e = document.createElement(tag); e.className = cls; return e; }
function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
