export class IndexCoordinator {
  constructor(
    private readonly actions: {
      clearPersistence: () => Promise<void>;
      buildWorkspace: () => Promise<void>;
    }
  ) {}

  async rebuild(): Promise<void> {
    await this.actions.clearPersistence();
    await this.actions.buildWorkspace();
  }
}
