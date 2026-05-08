import * as vscode from 'vscode';
import type { SymbolRecord } from '../indexes/symbolIndex';
import { SemanticIndex, createSymbolSemanticKey } from './semanticIndex';
import type { SemanticMetadata, SemanticTarget } from './semanticTypes';
import type { ProviderCallResult } from '../bridge/providerBridge';
import type { DiscoveryResult } from '../commands/findUsages';

export type SemanticProviders = {
  getDefinitions: (uri: vscode.Uri, position: vscode.Position) => Promise<ProviderCallResult<SemanticTarget[]>>;
  getDeclarations: (uri: vscode.Uri, position: vscode.Position) => Promise<ProviderCallResult<SemanticTarget[]>>;
  getTypeDefinitions: (uri: vscode.Uri, position: vscode.Position) => Promise<ProviderCallResult<SemanticTarget[]>>;
  getImplementations: (uri: vscode.Uri, position: vscode.Position) => Promise<DiscoveryResult[]>;
  getReferences: (uri: vscode.Uri, position: vscode.Position) => Promise<DiscoveryResult[]>;
  getHoverSummary: (uri: vscode.Uri, position: vscode.Position) => Promise<ProviderCallResult<string | undefined>>;
};

export type SemanticEnrichmentServiceOptions = {
  enabled: boolean;
  concurrency: number;
  timeoutMs: number;
  providers: SemanticProviders;
  now?: () => number;
  onError?: (message: string) => void;
};

type WorkItem = {
  relativePath: string;
  symbol: SymbolRecord;
  generation: number;
};

export class SemanticEnrichmentService {
  private readonly semanticIndex: SemanticIndex;
  private readonly options: Required<SemanticEnrichmentServiceOptions>;
  private readonly queue: WorkItem[] = [];
  private readonly cancelledGenerations = new Set<number>();
  private activeWorkers = 0;
  private drainPromise: Promise<void> | null = null;
  private drainResolve: (() => void) | null = null;

  constructor(semanticIndex: SemanticIndex, options: SemanticEnrichmentServiceOptions) {
    this.semanticIndex = semanticIndex;
    this.options = {
      ...options,
      now: options.now ?? (() => Date.now()),
      onError: options.onError ?? (() => {})
    };
  }

  enqueueFile(relativePath: string, symbols: SymbolRecord[], generation: number): void {
    if (!this.options.enabled) {
      return;
    }

    for (const symbol of symbols) {
      if (symbol.approximate) {
        continue;
      }
      this.queue.push({ relativePath, symbol, generation });
    }

    this.drain();
  }

  cancelGeneration(generation: number): void {
    this.cancelledGenerations.add(generation);
  }

  clear(): void {
    this.queue.length = 0;
    this.semanticIndex.clear();
  }

  async idle(): Promise<void> {
    while (this.queue.length > 0 || this.activeWorkers > 0) {
      if (this.drainPromise) {
        await this.drainPromise;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private drain(): void {
    if (this.activeWorkers >= this.options.concurrency) {
      return;
    }

    while (this.activeWorkers < this.options.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) {
        break;
      }
      this.processItem(item);
    }
  }

  private async processItem(item: WorkItem): Promise<void> {
    this.activeWorkers++;

    try {
      // Check if generation was cancelled
      if (this.cancelledGenerations.has(item.generation)) {
        return;
      }

      const uri = vscode.Uri.parse(item.symbol.uri);
      const position = new vscode.Position(item.symbol.startLine, item.symbol.startColumn);

      // Collect metadata from all providers with timeout
      const metadata = await this.enrichSymbol(uri, position);

      // Double-check generation not cancelled before writing
      if (this.cancelledGenerations.has(item.generation)) {
        return;
      }

      const key = createSymbolSemanticKey(item.symbol);
      this.semanticIndex.set(item.relativePath, key, metadata);
    } catch (error) {
      this.options.onError(`Error enriching symbol ${item.symbol.name}: ${error}`);
    } finally {
      this.activeWorkers--;
      if (this.activeWorkers === 0 && this.queue.length === 0 && this.drainResolve) {
        this.drainResolve();
        this.drainPromise = null;
        this.drainResolve = null;
      }
      this.drain();
    }
  }

  private async enrichSymbol(uri: vscode.Uri, position: vscode.Position): Promise<SemanticMetadata> {
    const timeoutMs = this.options.timeoutMs;
    
    try {
      const result = await withTimeout(
        this.collectSemanticData(uri, position),
        timeoutMs
      );

      return {
        ...result,
        provider: 'vscode',
        status: 'enriched',
        enrichedAt: this.options.now()
      };
    } catch (error) {
      if (error instanceof TimeoutError) {
        this.options.onError(`Provider timeout for ${uri.toString()} at ${position.line}:${position.character}`);
        return {
          provider: 'vscode',
          status: 'timeout',
          confidence: 0,
          enrichedAt: this.options.now()
        };
      }
      
      this.options.onError(`Provider failed for ${uri.toString()}: ${error}`);
      return {
        provider: 'vscode',
        status: 'failed',
        confidence: 0,
        enrichedAt: this.options.now()
      };
    }
  }

  private async collectSemanticData(
    uri: vscode.Uri,
    position: vscode.Position
  ): Promise<Omit<SemanticMetadata, 'provider' | 'status' | 'enrichedAt'>> {
    const [
      definitionsResult,
      declarationsResult,
      typeDefinitionsResult,
      implementations,
      references,
      hoverResult
    ] = await Promise.all([
      this.options.providers.getDefinitions(uri, position),
      this.options.providers.getDeclarations(uri, position),
      this.options.providers.getTypeDefinitions(uri, position),
      this.options.providers.getImplementations(uri, position),
      this.options.providers.getReferences(uri, position),
      this.options.providers.getHoverSummary(uri, position)
    ]);

    // Check for provider failures
    if (!definitionsResult.ok || !declarationsResult.ok || !typeDefinitionsResult.ok || !hoverResult.ok) {
      throw new Error('Provider call failed');
    }

    const definition = definitionsResult.value[0];
    const declaration = declarationsResult.value[0];
    const typeDefinition = typeDefinitionsResult.value[0];
    const implementationCount = implementations.length;
    const referenceCount = references.length;
    const hoverSummary = hoverResult.value;

    // Confidence is 1 when definitions exist, else 0.75
    const confidence = definition ? 1 : 0.75;

    return {
      definition,
      declaration,
      typeDefinition,
      implementationCount,
      referenceCount,
      hoverSummary,
      confidence
    };
  }
}

class TimeoutError extends Error {
  constructor() {
    super('Operation timed out');
    this.name = 'TimeoutError';
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new TimeoutError()), timeoutMs)
    )
  ]);
}
