export type SemanticTarget = {
  uri: string;
  line: number;
  column: number;
};

export type SemanticStatus = 'pending' | 'enriched' | 'missing-provider' | 'failed' | 'timeout' | 'cancelled';

export type SemanticMetadata = {
  definition?: SemanticTarget;
  declaration?: SemanticTarget;
  typeDefinition?: SemanticTarget;
  implementationCount?: number;
  referenceCount?: number;
  hoverSummary?: string;
  provider: 'vscode';
  status: SemanticStatus;
  confidence: number;
  enrichedAt: number;
};

export type SemanticEnrichmentConfig = {
  semanticEnrichment: boolean;
  semanticConcurrency: number;
  semanticTimeoutMs: number;
};
