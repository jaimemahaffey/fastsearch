import * as path from 'node:path';
import { scoreCandidate } from '../shared/matchScore';
import type { FileRecord } from '../shared/types';

export class FileIndex {
  private readonly entries = new Map<string, FileRecord>();

  isEmpty(): boolean {
    return this.entries.size === 0;
  }

  upsert(relativePath: string, uri: string): void {
    this.entries.set(relativePath, {
      relativePath,
      uri,
      basename: path.basename(relativePath),
      extension: path.extname(relativePath),
      // Kept for upcoming token-based matching so we do not need to rescan metadata later.
      tokens: relativePath.toLowerCase().split(/[\\/._-]+/)
    });
  }

  search(query: string): FileRecord[] {
    return [...this.entries.values()]
      .map((entry) => ({
        entry,
        score: Math.max(
          scoreCandidate(query, entry.basename),
          scoreCandidate(query, entry.relativePath)
        )
      }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score || a.entry.relativePath.localeCompare(b.entry.relativePath))
      .map((item) => item.entry);
  }
}
