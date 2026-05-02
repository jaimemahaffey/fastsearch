export type TextMatch = {
  relativePath: string;
  uri: string;
  line: number;
  column: number;
  preview: string;
};

export class TextIndex {
  private readonly contents = new Map<string, { uri: string; content: string }>();

  upsert(relativePath: string, uri: string, content: string): void {
    this.contents.set(relativePath, { uri, content });
  }

  search(query: string): TextMatch[] {
    const needle = query.toLowerCase();
    const results: TextMatch[] = [];

    for (const [relativePath, entry] of this.contents) {
      const { uri, content } = entry;
      const lines = content.split(/\r?\n/);
      lines.forEach((line, index) => {
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
    }

    return results;
  }
}
