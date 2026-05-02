import * as vscode from 'vscode';
import { IndexCoordinator } from '../core/indexCoordinator';

export async function rebuildIndex(coordinator: IndexCoordinator): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      cancellable: false,
      title: 'Rebuilding Fast Symbol Index'
    },
    async () => coordinator.rebuild()
  );
}
