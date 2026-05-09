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
  private readonly byFile = new Map<string, { contentHash?: string | null; symbols: SymbolRecord[] }>();

  allByFile(): Array<{ relativePath: string; contentHash?: string | null; symbols: SymbolRecord[]; }> {
    return [...this.byFile.entries()].map(([relativePath, symbols]) => ({
      relativePath,
      contentHash: symbols.contentHash,
      symbols: [...symbols.symbols]
    }));
  }

  all(): SymbolRecord[] {
    return [...this.byFile.values()].flatMap((entry) => entry.symbols);
  }

  isEmpty(): boolean {
    return this.byFile.size === 0 || [...this.byFile.values()].every((entry) => entry.symbols.length === 0);
  }

  clear(): void {
    this.byFile.clear();
  }

  replaceForFile(relativePath: string, symbols: SymbolRecord[], contentHash?: string | null): void {
    this.byFile.set(relativePath, { symbols, contentHash });
  }

  removeForFile(relativePath: string): void {
    this.byFile.delete(relativePath);
  }

  search(query: string): SymbolRecord[] {
    const needle = query.toLowerCase();
    return [...this.byFile.values()]
      .flatMap((entry) => entry.symbols)
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
