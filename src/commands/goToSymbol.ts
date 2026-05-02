import * as vscode from 'vscode';
import { SymbolIndex } from '../indexes/symbolIndex';

export async function goToSymbol(symbolIndex: SymbolIndex): Promise<void> {
  if (symbolIndex.isEmpty()) {
    void vscode.window.showInformationMessage('No indexed symbols are available yet.');
    return;
  }

  const query = await vscode.window.showInputBox({ prompt: 'Search indexed symbols' });
  if (!query) {
    return;
  }

  const matches = symbolIndex.search(query);
  if (matches.length === 0) {
    void vscode.window.showInformationMessage(`No indexed symbols matched "${query}".`);
    return;
  }

  const pick = await vscode.window.showQuickPick(
    matches.map((symbol) => ({
      label: symbol.name,
      description: symbol.containerName,
      detail: symbol.approximate ? 'Approximate match' : 'Provider-backed match',
      symbol
    }))
  );

  if (!pick) {
    return;
  }

  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(pick.symbol.uri));
    const editor = await vscode.window.showTextDocument(document);
    const position = new vscode.Position(pick.symbol.startLine, pick.symbol.startColumn);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position));
  } catch {
    void vscode.window.showErrorMessage(`Unable to open indexed symbol: ${pick.symbol.name}`);
  }
}
