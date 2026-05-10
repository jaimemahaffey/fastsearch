import type { SymbolHydrationPlanItem } from './symbolHydrationPlan';

export type SymbolHydrationWorkerStatus = 'hydrated' | 'failed' | 'timedOut' | 'skipped';

export type SymbolHydrationWorkerResult = {
  status: SymbolHydrationWorkerStatus;
};

export type SymbolHydrationStatusCounts = {
  queued: number;
  running: number;
  hydrated: number;
  failed: number;
  timedOut: number;
  skipped: number;
};

type QueuedSymbolHydrationItem = {
  item: SymbolHydrationPlanItem;
  generation: number;
};

export type SymbolHydrationSchedulerOptions = {
  concurrency: number;
  batchSize: number;
  getGeneration: () => number;
  isCurrent: (item: SymbolHydrationPlanItem, generation: number) => boolean;
  worker: (item: SymbolHydrationPlanItem) => Promise<SymbolHydrationWorkerResult>;
  onBatchComplete?: (counts: SymbolHydrationStatusCounts) => Promise<void> | void;
};

export class SymbolHydrationScheduler {
  private readonly queue: QueuedSymbolHydrationItem[] = [];
  private readonly counts: SymbolHydrationStatusCounts = {
    queued: 0,
    running: 0,
    hydrated: 0,
    failed: 0,
    timedOut: 0,
    skipped: 0
  };
  private cancelled = false;
  private completedSinceCheckpoint = 0;
  private checkpointTail: Promise<void> = Promise.resolve();
  private drainPromise: Promise<void> | undefined;

  constructor(private readonly options: SymbolHydrationSchedulerOptions) {}

  enqueue(items: SymbolHydrationPlanItem[], generation = this.options.getGeneration()): void {
    if (items.length === 0) {
      return;
    }

    this.queue.push(...items.map((item) => ({ item, generation })));
    this.counts.queued = this.queue.length;
  }

  cancel(): void {
    this.cancelled = true;
    this.counts.skipped += this.queue.length;
    this.queue.length = 0;
    this.counts.queued = 0;
  }

  getStatusCounts(): SymbolHydrationStatusCounts {
    return { ...this.counts, queued: this.queue.length };
  }

  drain(): Promise<void> {
    if (this.drainPromise) {
      return this.drainPromise;
    }

    let drainPromise!: Promise<void>;
    drainPromise = this.drainInternal().finally(() => {
      if (this.drainPromise === drainPromise) {
        this.drainPromise = undefined;
      }
    });
    this.drainPromise = drainPromise;
    return drainPromise;
  }

  private async drainInternal(): Promise<void> {
    do {
      const workerCount = Math.max(1, Math.min(this.options.concurrency, this.queue.length || 1));
      await Promise.all(Array.from({ length: workerCount }, () => this.runWorker()));
      await this.flushCheckpoint();
      await this.checkpointTail;
    } while (!this.cancelled && this.queue.length > 0);
  }

  private async runWorker(): Promise<void> {
    while (!this.cancelled) {
      const next = this.queue.shift();
      this.counts.queued = this.queue.length;
      if (!next) {
        return;
      }

      if (!this.options.isCurrent(next.item, next.generation)) {
        this.counts.skipped += 1;
        await this.recordCompletion();
        continue;
      }

      this.counts.running += 1;
      let status: SymbolHydrationWorkerStatus = 'failed';
      try {
        const result = await this.options.worker(next.item);
        status = result.status;
      } catch {
        status = 'failed';
      } finally {
        this.counts.running -= 1;
      }
      await this.recordResult(status);
    }
  }

  private async recordResult(status: SymbolHydrationWorkerStatus): Promise<void> {
    this.counts[status] += 1;
    await this.recordCompletion();
  }

  private recordCompletion(): Promise<void> {
    this.completedSinceCheckpoint += 1;
    if (this.completedSinceCheckpoint < this.batchSize) {
      return Promise.resolve();
    }

    this.completedSinceCheckpoint = 0;
    return this.enqueueCheckpoint(this.getStatusCounts());
  }

  private flushCheckpoint(): Promise<void> {
    if (this.completedSinceCheckpoint === 0) {
      return Promise.resolve();
    }

    this.completedSinceCheckpoint = 0;
    return this.enqueueCheckpoint(this.getStatusCounts());
  }

  private async enqueueCheckpoint(counts: SymbolHydrationStatusCounts): Promise<void> {
    const run = this.checkpointTail.then(async () => {
      await this.options.onBatchComplete?.(counts);
    });
    this.checkpointTail = run.catch(() => undefined);
    await run;
  }

  private get batchSize(): number {
    return Math.max(1, this.options.batchSize);
  }
}
