import * as vscode from 'vscode';
import { goToFile } from './commands/goToFile';
import { goToText } from './commands/goToText';
import { readConfig } from './configuration';
import { FileIndex } from './indexes/fileIndex';
import { TextIndex } from './indexes/textIndex';
import { isEligibleTextFile } from './shared/fileEligibility';

const WORKSPACE_FILE_EXCLUDE_GLOB = '**/{node_modules,.git,.hg,.svn,dist,build,coverage,out,target}/**';

const STUB_COMMANDS = [
  'fastIndexer.goToSymbol',
  'fastIndexer.findUsages',
  'fastIndexer.findImplementations',
  'fastIndexer.rebuildIndex'
] as const;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Fast Symbol Indexer');
  const config = readConfig();
  const fileIndex = new FileIndex();
  const textIndex = new TextIndex();
  let initialFileIndexBuildPending = true;
  const initialFileIndexBuild = buildWorkspaceIndexes(fileIndex, textIndex, config.maxFileSizeKb, output).finally(() => {
    initialFileIndexBuildPending = false;
  });

  output.appendLine(`fastIndexer enabled=${config.enabled}`);

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.goToFile', async () => {
    if (initialFileIndexBuildPending) {
      void vscode.window.showInformationMessage('Building initial file index. Please wait a moment.');
    }

    await initialFileIndexBuild;
    await goToFile(fileIndex);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.goToText', async () => {
    if (initialFileIndexBuildPending) {
      void vscode.window.showInformationMessage('Building initial file index. Please wait a moment.');
    }

    await initialFileIndexBuild;
    await goToText(textIndex);
  }));

  for (const command of STUB_COMMANDS) {
    context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
      void vscode.window.showInformationMessage(`${command} is not implemented yet.`);
    }));
  }

  context.subscriptions.push(output);
}

async function buildWorkspaceIndexes(
  fileIndex: FileIndex,
  textIndex: TextIndex,
  maxFileSizeKb: number,
  output: vscode.OutputChannel
): Promise<void> {
  try {
    const files = await vscode.workspace.findFiles('**/*', WORKSPACE_FILE_EXCLUDE_GLOB);

    for (const file of files) {
      const relativePath = vscode.workspace.asRelativePath(file, true);
      fileIndex.upsert(relativePath, file.toString(), toIndexedFileKey(file, relativePath));

      try {
        const bytes = await vscode.workspace.fs.readFile(file);
        if (isEligibleTextFile(relativePath, bytes.byteLength, maxFileSizeKb)) {
          textIndex.upsert(relativePath, file.toString(), Buffer.from(bytes).toString('utf8'));
        }
      } catch (error) {
        output.appendLine(`Failed to read ${relativePath} for text indexing: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    output.appendLine(`Failed to build initial file index: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function toIndexedFileKey(file: vscode.Uri, relativePath: string): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(file);
  if (!workspaceFolder) {
    return relativePath;
  }

  return `${workspaceFolder.uri.toString()}::${relativePath}`;
}
