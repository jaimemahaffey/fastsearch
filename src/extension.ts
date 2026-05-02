import * as vscode from 'vscode';
import { goToFile } from './commands/goToFile';
import { readConfig } from './configuration';
import { FileIndex } from './indexes/fileIndex';

const WORKSPACE_FILE_EXCLUDE_GLOB = '**/{node_modules,.git,.hg,.svn,dist,build,coverage,out,target}/**';

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
  const fileIndex = new FileIndex();
  const initialFileIndexBuild = buildWorkspaceFileIndex(fileIndex, output);

  output.appendLine(`fastIndexer enabled=${config.enabled}`);

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.goToFile', async () => {
    await initialFileIndexBuild;
    await goToFile(fileIndex);
  }));

  for (const command of STUB_COMMANDS) {
    context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
      void vscode.window.showInformationMessage(`${command} is not implemented yet.`);
    }));
  }

  context.subscriptions.push(output);
}

async function buildWorkspaceFileIndex(fileIndex: FileIndex, output: vscode.OutputChannel): Promise<void> {
  try {
    const files = await vscode.workspace.findFiles('**/*', WORKSPACE_FILE_EXCLUDE_GLOB);

    for (const file of files) {
      fileIndex.upsert(vscode.workspace.asRelativePath(file, false), file.toString());
    }
  } catch (error) {
    output.appendLine(`Failed to build initial file index: ${error instanceof Error ? error.message : String(error)}`);
  }
}
