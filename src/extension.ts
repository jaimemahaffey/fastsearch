import * as vscode from 'vscode';
import { readConfig } from './configuration';

const COMMANDS = [
  'fastIndexer.goToFile',
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

  for (const command of COMMANDS) {
    context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
      void vscode.window.showInformationMessage(`${command} is not implemented yet.`);
    }));
  }

  context.subscriptions.push(output);
}
