import * as vscode from 'vscode';
import { goToFile } from './commands/goToFile';
import { readConfig } from './configuration';
import { FileIndex } from './indexes/fileIndex';

const STUB_COMMANDS = [
  'fastIndexer.goToSymbol',
  'fastIndexer.goToText',
  'fastIndexer.findUsages',
  'fastIndexer.findImplementations',
  'fastIndexer.rebuildIndex'
] as const;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Fast Symbol Indexer');
  const config = readConfig();

  output.appendLine(`fastIndexer enabled=${config.enabled}`);

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.goToFile', async () => {
    const fileIndex = new FileIndex();
    const files = await vscode.workspace.findFiles('**/*');

    if (files.length === 0) {
      return;
    }

    for (const file of files) {
      fileIndex.upsert(vscode.workspace.asRelativePath(file, false), file.toString());
    }

    await goToFile(fileIndex);
  }));

  for (const command of STUB_COMMANDS) {
    context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
      void vscode.window.showInformationMessage(`${command} is not implemented yet.`);
    }));
  }

  context.subscriptions.push(output);
}
