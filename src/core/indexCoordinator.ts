export type IndexState = 'idle' | 'warming' | 'ready' | 'stale' | 'rebuilding';

export class IndexCoordinator {
  private state: IndexState = 'idle';

  constructor(
    private readonly actions: {
      clearIndexes: () => void | Promise<void>;
      clearPersistence: () => Promise<void>;
      buildWorkspace: () => Promise<void>;
    }
  ) {}

  getState(): IndexState {
    return this.state;
  }

  markWarming(): void {
    this.state = 'warming';
  }

  markReady(): void {
    this.state = 'ready';
  }

  markStale(): void {
    this.state = 'stale';
  }

  async rebuild(): Promise<void> {
    this.state = 'rebuilding';

    try {
      await this.actions.clearIndexes();
      await this.actions.clearPersistence();
      await this.actions.buildWorkspace();
      this.state = 'ready';
    } catch (error) {
      this.state = 'stale';
      throw error;
    }
  }
}
