import * as vscode from 'vscode';
import { FileIndex } from '../indexes/fileIndex';

export async function goToFile(fileIndex: FileIndex): Promise<void> {
  if (fileIndex.isEmpty()) {
    void vscode.window.showInformationMessage('No indexed files are available yet.');
    return;
  }

  const query = await vscode.window.showInputBox({ prompt: 'Search indexed files' });
  if (!query) {
    return;
  }

  const pick = await vscode.window.showQuickPick(
    fileIndex.search(query).map((entry) => ({
      label: entry.basename,
      description: entry.relativePath,
      entry
    }))
  );

  if (pick) {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(pick.entry.uri));
      await vscode.window.showTextDocument(document);
    } catch {
      void vscode.window.showErrorMessage(`Unable to open indexed file: ${pick.entry.relativePath}`);
    }
  }
}
