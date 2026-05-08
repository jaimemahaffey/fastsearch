import type { SymbolRecord } from '../indexes/symbolIndex';
import type { SemanticMetadata } from './semanticTypes';

export type SemanticIndexEntry = {
  key: string;
  metadata: SemanticMetadata;
};

export type SemanticIndexFileEntry = {
  relativePath: string;
  entries: SemanticIndexEntry[];
};

export class SemanticIndex {
  private readonly byFile = new Map<string, Map<string, SemanticMetadata>>();

  allByFile(): SemanticIndexFileEntry[] {
    return [...this.byFile.entries()].map(([relativePath, entries]) => ({
      relativePath,
      entries: [...entries.entries()].map(([key, metadata]) => ({ key, metadata: { ...metadata } }))
    }));
  }

  clear(): void {
    this.byFile.clear();
  }

  get(relativePath: string, key: string): SemanticMetadata | undefined {
    const metadata = this.byFile.get(relativePath)?.get(key);
    return metadata ? { ...metadata } : undefined;
  }

  set(relativePath: string, key: string, metadata: SemanticMetadata): void {
    const entries = this.byFile.get(relativePath) ?? new Map<string, SemanticMetadata>();
    entries.set(key, { ...metadata });
    this.byFile.set(relativePath, entries);
  }

  replaceForFile(relativePath: string, entries: SemanticIndexEntry[]): void {
    this.byFile.set(
      relativePath,
      new Map(entries.map((entry) => [entry.key, { ...entry.metadata }]))
    );
  }
}

export function createSymbolSemanticKey(symbol: Pick<SymbolRecord, 'name' | 'kind' | 'containerName' | 'startLine' | 'startColumn'>): string {
  return [
    symbol.name,
    symbol.kind,
    symbol.containerName ?? '',
    symbol.startLine,
    symbol.startColumn
  ].join(':');
}
