export type FileRecord = {
  relativePath: string;
  uri: string;
  basename: string;
  extension: string;
  // Reserved for future token-aware ranking work; current search uses basename/path scoring only.
  tokens: string[];
};

export type WorkspacePersistence = {
  workspaceId: string;
};

export type IndexLayer = 'file' | 'text' | 'symbol' | 'semantic';

export type PersistedLayerState = {
  availableLayers: IndexLayer[];
  activeLayer?: IndexLayer;
};
