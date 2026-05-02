export type TextMatch = {
  relativePath: string;
  uri: string;
  line: number;
  column: number;
  preview: string;
};

const MAX_TEXT_SEARCH_RESULTS = 200;

export class TextIndex {
  private readonly contents = new Map<string, { uri: string; content: string }>();

  isEmpty(): boolean {
    return this.contents.size === 0;
  }

  upsert(relativePath: string, uri: string, content: string): void {
    this.contents.set(relativePath, { uri, content });
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
}
