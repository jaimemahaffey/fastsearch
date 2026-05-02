import { readdirSync } from 'node:fs';
import * as path from 'node:path';
import Mocha from 'mocha';

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    grep: process.env.MOCHA_GREP ? new RegExp(process.env.MOCHA_GREP) : undefined
  });

  const testFiles = readdirSync(__dirname)
    .filter((file) => file.endsWith('.test.js'))
    .sort();

  if (testFiles.length === 0) {
    throw new Error('No compiled test files found.');
  }

  for (const file of testFiles) {
    mocha.addFile(path.resolve(__dirname, file));
  }

  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => failures === 0 ? resolve() : reject(new Error(`${failures} tests failed`)));
  });
}
