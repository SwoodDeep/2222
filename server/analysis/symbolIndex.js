// Global symbol index across all parsed files.
export class SymbolIndex {
  constructor() {
    this.byName = new Map();   // name -> [{file, symbol}]
    this.byFile = new Map();   // file -> [symbols]
    this.all = [];
  }

  build(files) {
    for (const [path, facts] of files) {
      const syms = facts.symbols || [];
      this.byFile.set(path, syms);
      for (const s of syms) {
        if (!this.byName.has(s.name)) this.byName.set(s.name, []);
        this.byName.get(s.name).push({ file: path, symbol: s });
        this.all.push({ file: path, ...s });
      }
    }
  }

  lookup(name) {
    return this.byName.get(name) || [];
  }

  // exported names per file
  exportedNames(facts) {
    return new Set((facts.exports || []).map((e) => e.name));
  }
}
