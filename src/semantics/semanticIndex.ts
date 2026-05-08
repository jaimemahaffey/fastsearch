import type { SymbolRecord } from '../indexes/symbolIndex';
import type { SemanticMetadata, SemanticTarget } from './semanticTypes';

export type SemanticIndexEntry = {
  key: string;
  metadata: SemanticMetadata;
};

export type SemanticIndexFileEntry = {
  relativePath: string;
  entries: SemanticIndexEntry[];
};

function cloneSemanticTarget(target: SemanticTarget | undefined): SemanticTarget | undefined {
  return target ? { uri: target.uri, line: target.line, column: target.column } : undefined;
}

function cloneSemanticMetadata(metadata: SemanticMetadata): SemanticMetadata {
  const cloned: SemanticMetadata = {
    provider: metadata.provider,
    status: metadata.status,
    confidence: metadata.confidence,
    enrichedAt: metadata.enrichedAt
  };

  if (metadata.definition !== undefined) {
    cloned.definition = cloneSemanticTarget(metadata.definition);
  }
  if (metadata.declaration !== undefined) {
    cloned.declaration = cloneSemanticTarget(metadata.declaration);
  }
  if (metadata.typeDefinition !== undefined) {
    cloned.typeDefinition = cloneSemanticTarget(metadata.typeDefinition);
  }
  if (metadata.implementationCount !== undefined) {
    cloned.implementationCount = metadata.implementationCount;
  }
  if (metadata.referenceCount !== undefined) {
    cloned.referenceCount = metadata.referenceCount;
  }
  if (metadata.hoverSummary !== undefined) {
    cloned.hoverSummary = metadata.hoverSummary;
  }

  return cloned;
}

export class SemanticIndex {
  private readonly byFile = new Map<string, Map<string, SemanticMetadata>>();

  allByFile(): SemanticIndexFileEntry[] {
    return [...this.byFile.entries()].map(([relativePath, entries]) => ({
      relativePath,
      entries: [...entries.entries()].map(([key, metadata]) => ({ key, metadata: cloneSemanticMetadata(metadata) }))
    }));
  }

  clear(): void {
    this.byFile.clear();
  }

  get(relativePath: string, key: string): SemanticMetadata | undefined {
    const metadata = this.byFile.get(relativePath)?.get(key);
    return metadata ? cloneSemanticMetadata(metadata) : undefined;
  }

  set(relativePath: string, key: string, metadata: SemanticMetadata): void {
    const entries = this.byFile.get(relativePath) ?? new Map<string, SemanticMetadata>();
    entries.set(key, cloneSemanticMetadata(metadata));
    this.byFile.set(relativePath, entries);
  }

  replaceForFile(relativePath: string, entries: SemanticIndexEntry[]): void {
    this.byFile.set(
      relativePath,
      new Map(entries.map((entry) => [entry.key, cloneSemanticMetadata(entry.metadata)]))
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
