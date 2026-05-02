import * as vscode from 'vscode';
import { TextIndex } from '../indexes/textIndex';

export async function goToText(textIndex: TextIndex): Promise<void> {
  if (textIndex.isEmpty()) {
    void vscode.window.showInformationMessage('No indexed text is available yet.');
    return;
  }

  const query = await vscode.window.showInputBox({ prompt: 'Search indexed text' });
  if (!query) {
    return;
  }

  const pick = await vscode.window.showQuickPick(
    textIndex.search(query).map((match) => ({
      label: `${match.relativePath}:${match.line}`,
      description: match.preview,
      match
    }))
  );

  if (!pick) {
    return;
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(pick.match.uri));
  const editor = await vscode.window.showTextDocument(document);
  const position = new vscode.Position(pick.match.line - 1, pick.match.column - 1);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position));
}
