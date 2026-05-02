import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

const extensionDevelopmentPath = path.resolve(__dirname, '../..');
const workspacePath = path.resolve(extensionDevelopmentPath, 'src', 'test', 'fixtures', 'workspace');
const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.js');

async function main(): Promise<void> {
  await fs.mkdir(workspacePath, { recursive: true });

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspacePath]
  });
}

void main();
