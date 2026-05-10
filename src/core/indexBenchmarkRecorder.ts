import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type IndexBenchmarkEvent = {
  event: 'fileReady' | 'textReady' | 'symbolUsable' | 'symbolComplete' | 'symbolBatch';
  elapsedMs: number;
  count?: number;
};

export type IndexBenchmarkRecorder = {
  enabled: boolean;
  record: (event: IndexBenchmarkEvent) => void;
  flush: () => Promise<void>;
};

export function createIndexBenchmarkRecorder(outputPath: string | undefined): IndexBenchmarkRecorder {
  if (!outputPath) {
    return {
      enabled: false,
      record: () => undefined,
      flush: async () => undefined
    };
  }

  const events: IndexBenchmarkEvent[] = [];
  let flushTail: Promise<void> = Promise.resolve();

  return {
    enabled: true,
    record: (event) => {
      events.push({ ...event });
    },
    flush: () => {
      const snapshot = events.map((event) => ({ ...event }));
      const run = flushTail.then(async () => {
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, JSON.stringify({ events: snapshot }, undefined, 2), 'utf8');
      });
      flushTail = run.catch(() => undefined);
      return run;
    }
  };
}
