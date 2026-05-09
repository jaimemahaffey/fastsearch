import type { DiscoveryResult } from '../commands/findUsages';
import { scoreCandidate } from '../shared/matchScore';

export type TextMatch = {
  relativePath: string;
  uri: string;
  line: number;
  column: number;
  preview: string;
};

const MAX_TEXT_SEARCH_RESULTS = 200;

export class TextIndex {
  private readonly contents = new Map<string, { uri: string; content: string; contentHash?: string | null }>();

  allContents(): Array<{ relativePath: string; uri: string; content: string; contentHash?: string | null; }> {
    return [...this.contents.entries()].map(([relativePath, entry]) => ({
      relativePath,
      uri: entry.uri,
      content: entry.content,
      contentHash: entry.contentHash
    }));
  }

  isEmpty(): boolean {
    return this.contents.size === 0;
  }

  clear(): void {
    this.contents.clear();
  }

  upsert(relativePath: string, uri: string, content: string, contentHash?: string | null): void {
    this.contents.set(relativePath, { uri, content, contentHash });
  }

  removeForFile(relativePath: string): void {
    this.contents.delete(relativePath);
  }

  search(query: string): TextMatch[] {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return [];
    }

    const results: TextMatch[] = [];

    for (const [relativePath, entry] of this.contents) {
      const { uri, content } = entry;
      const lines = content.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (results.length >= MAX_TEXT_SEARCH_RESULTS) {
          return;
        }

        const column = line.toLowerCase().indexOf(needle);
        if (column >= 0) {
          results.push({
            relativePath,
            uri,
            line: index + 1,
            column: column + 1,
            preview: line.trim()
          });
        }
      });

      if (results.length >= MAX_TEXT_SEARCH_RESULTS) {
        break;
      }
    }

    return results;
  }

  searchForCommand(query: string, fuzzySearch: boolean): TextMatch[] {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return [];
    }

    const rankedResults: Array<{ match: TextMatch; score: number; }> = [];

    for (const [relativePath, entry] of this.contents) {
      const { uri, content } = entry;
      const lines = content.split(/\r?\n/);

      lines.forEach((line, index) => {
        if (rankedResults.length >= MAX_TEXT_SEARCH_RESULTS) {
          return;
        }

        const substringColumn = line.toLowerCase().indexOf(needle);
        const score = fuzzySearch
          ? Math.max(
            scoreCandidate(query, line),
            scoreCandidate(query, `${relativePath} ${line}`),
            scoreCandidate(query, relativePath)
          )
          : (substringColumn >= 0 ? 150 : -1);

        if (score < 0) {
          return;
        }

        rankedResults.push({
          score,
          match: {
            relativePath,
            uri,
            line: index + 1,
            column: substringColumn >= 0 ? substringColumn + 1 : 1,
            preview: line.trim()
          }
        });
      });

      if (rankedResults.length >= MAX_TEXT_SEARCH_RESULTS) {
        break;
      }
    }

    return rankedResults
      .sort((left, right) =>
        right.score - left.score
        || left.match.relativePath.localeCompare(right.match.relativePath)
        || left.match.line - right.match.line
      )
      .map((entry) => entry.match);
  }

  findApproximateUsages(query: string): DiscoveryResult[] {
    return this.search(query).map((match) => ({
      uri: match.uri,
      line: match.line - 1,
      approximate: true
    }));
  }
}
