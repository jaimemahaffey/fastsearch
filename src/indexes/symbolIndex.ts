export type SymbolRecord = {
  name: string;
  kind: number;
  containerName?: string;
  uri: string;
  startLine: number;
  startColumn: number;
  approximate: boolean;
};

export class SymbolIndex {
  private readonly byFile = new Map<string, SymbolRecord[]>();

  isEmpty(): boolean {
    return this.byFile.size === 0 || [...this.byFile.values()].every((symbols) => symbols.length === 0);
  }

  replaceForFile(relativePath: string, symbols: SymbolRecord[]): void {
    this.byFile.set(relativePath, symbols);
  }

  search(query: string): SymbolRecord[] {
    const needle = query.toLowerCase();
    return [...this.byFile.values()]
      .flat()
      .filter((symbol) => symbol.name.toLowerCase().includes(needle))
      .sort((a, b) => Number(a.approximate) - Number(b.approximate) || a.name.localeCompare(b.name));
  }
}
