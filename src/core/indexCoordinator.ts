export class IndexCoordinator {
  constructor(
    private readonly actions: {
      clearIndexes: () => void | Promise<void>;
      clearPersistence: () => Promise<void>;
      buildWorkspace: () => Promise<void>;
    }
  ) {}

  async rebuild(): Promise<void> {
    await this.actions.clearIndexes();
    await this.actions.clearPersistence();
    await this.actions.buildWorkspace();
  }
}
