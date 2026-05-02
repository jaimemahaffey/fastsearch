export type FileRecord = {
  relativePath: string;
  uri: string;
  basename: string;
  extension: string;
  // Reserved for future token-aware ranking work; current search uses basename/path scoring only.
  tokens: string[];
};
