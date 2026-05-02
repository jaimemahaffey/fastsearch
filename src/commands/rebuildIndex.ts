import * as vscode from 'vscode';
import { IndexCoordinator } from '../core/indexCoordinator';

export async function rebuildIndex(coordinator: IndexCoordinator): Promise<void> {
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        cancellable: false,
        title: 'Rebuilding Fast Symbol Index'
      },
      async () => coordinator.rebuild()
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Unable to rebuild Fast Symbol Index: ${message}`);
  }
}
