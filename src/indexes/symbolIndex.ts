import type { DiscoveryResult } from '../commands/findUsages';

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

  allByFile(): Array<{ relativePath: string; symbols: SymbolRecord[]; }> {
    return [...this.byFile.entries()].map(([relativePath, symbols]) => ({
      relativePath,
      symbols: [...symbols]
    }));
  }

  all(): SymbolRecord[] {
    return [...this.byFile.values()].flat();
  }

  isEmpty(): boolean {
    return this.byFile.size === 0 || [...this.byFile.values()].every((symbols) => symbols.length === 0);
  }

  clear(): void {
    this.byFile.clear();
  }

  removeForFile(relativePath: string): void {
    this.byFile.delete(relativePath);
  }

  moveFile(fromRelativePath: string, toRelativePath: string, toUri: string): void {
    const existing = this.byFile.get(fromRelativePath);
    if (!existing) {
      return;
    }

    this.byFile.delete(fromRelativePath);
    this.byFile.set(
      toRelativePath,
      existing.map((symbol) => ({
        ...symbol,
        uri: toUri
      }))
    );
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

  findApproximateUsages(query: string): DiscoveryResult[] {
    return this.toApproximateResults(query);
  }

  findApproximateImplementations(query: string): DiscoveryResult[] {
    return this.toApproximateResults(query);
  }

  private toApproximateResults(query: string): DiscoveryResult[] {
    return this.search(query).map((symbol) => ({
      uri: symbol.uri,
      line: symbol.startLine,
      approximate: true
    }));
  }
}
