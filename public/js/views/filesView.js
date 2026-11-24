// File Explorer mode: big tree in the center viewport.
import { CATEGORY_COLORS, CATEGORY_LABELS } from '../state.js';

export class FilesView {
  constructor(container, { onSelect } = {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.el = document.createElement('div');
    this.el.style.cssText = 'width:100%;height:100%;overflow:auto;padding:10px;font-family:ui-monospace,monospace;font-size:12px';
    container.appendChild(this.el);
  }

  setGraph(graph, tree, { onSelectNode } = {}) {
    this.graph = graph;
    this.tree = tree;
    this.renderNode(tree, this.el, 0, onSelectNode);
  }

  renderNode(node, host, depth, onSelectNode) {
    if (node.type === 'dir') {
      const row = document.createElement('div');
      row.className = 'tree-row';
      row.style.paddingLeft = 6 + depth * 14 + 'px';
      row.innerHTML = `<span class="tw">▾</span><span class="nm">${esc(node.name)}/</span>`;
      host.appendChild(row);
      const ch = document.createElement('div');
      ch.className = 'tree-children';
      host.appendChild(ch);
      for (const c of node.children || []) this.renderNode(c, ch, depth + 1, onSelectNode);
    } else {
      const row = document.createElement('div');
      row.className = 'tree-row';
      row.style.paddingLeft = 6 + depth * 14 + 'px';
      const cat = node.category;
      const color = CATEGORY_COLORS[cat] || '#adbac7';
      row.innerHTML = `<span class="tw"></span><span class="dot" style="width:7px;height:7px;border-radius:50%;background:${color};flex:0 0 auto"></span><span class="nm">${esc(node.name)}</span><span class="meta">${node.loc || 0} стр${node.risks?.length ? ' ⚠' : ''}</span>`;
      row.title = `${node.path} — ${CATEGORY_LABELS[cat] || cat}`;
      row.onclick = () => {
        document.querySelectorAll('#center-panel .tree-row.selected').forEach((r) => r.classList.remove('selected'));
        row.classList.add('selected');
        this.onSelect?.(node.path, this.graph?.nodes.find((n) => n.id === node.path));
      };
      host.appendChild(row);
    }
  }

  select(id) {
    // best-effort highlight
  }

  dispose() { this.el.remove(); }
}

function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
