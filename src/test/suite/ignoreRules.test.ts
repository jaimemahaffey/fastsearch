import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  createIgnoreMatcher,
  parseIgnoreFileContent,
  resolveConfiguredIgnoreFiles,
  type ResolvedIgnoreFile
} from '../../core/ignoreRules';

suite('ignoreRules', () => {
  test('resolves per-folder and shared ignore-file entries for a multi-root workspace', () => {
    const workspaceFolders = [
      {
        uri: vscode.Uri.file(path.join('c:\\workspace', 'app')),
        index: 0,
        name: 'app'
      },
      {
        uri: vscode.Uri.file(path.join('c:\\workspace', 'packages', 'lib')),
        index: 1,
        name: 'lib'
      }
    ] as readonly vscode.WorkspaceFolder[];

    const resolved = resolveConfiguredIgnoreFiles(
      {
        ignoreFiles: ['.fast-indexer-ignore'],
        sharedIgnoreFiles: [path.join('.config', 'fast-indexer', 'shared.ignore')]
      },
      workspaceFolders,
      vscode.Uri.file(path.join('c:\\workspace', 'fastsearch.code-workspace'))
    );

    assert.deepEqual(resolved, [
      {
        scope: 'workspace-folder',
        workspaceFolderPath: path.join('c:\\workspace', 'app'),
        ignoreFilePath: path.join('c:\\workspace', 'app', '.fast-indexer-ignore'),
        ruleBasePath: path.join('c:\\workspace', 'app')
      },
      {
        scope: 'workspace-folder',
        workspaceFolderPath: path.join('c:\\workspace', 'packages', 'lib'),
        ignoreFilePath: path.join('c:\\workspace', 'packages', 'lib', '.fast-indexer-ignore'),
        ruleBasePath: path.join('c:\\workspace', 'packages', 'lib')
      },
      {
        scope: 'workspace',
        ignoreFilePath: path.join('c:\\workspace', '.config', 'fast-indexer', 'shared.ignore'),
        ruleBasePath: path.join('c:\\workspace')
      }
    ]);
  });

  test('resolves shared ignore-file entries relative to the single workspace folder when no workspace file exists', () => {
    const workspaceFolders = [
      {
        uri: vscode.Uri.file(path.join('c:\\workspace', 'app')),
        index: 0,
        name: 'app'
      }
    ] as readonly vscode.WorkspaceFolder[];

    const resolved = resolveConfiguredIgnoreFiles(
      {
        ignoreFiles: [],
        sharedIgnoreFiles: ['.fast-indexer-shared-ignore']
      },
      workspaceFolders
    );

    assert.deepEqual(resolved, [
      {
        scope: 'workspace',
        ignoreFilePath: path.join('c:\\workspace', 'app', '.fast-indexer-shared-ignore'),
        ruleBasePath: path.join('c:\\workspace', 'app')
      }
    ]);
  });

  test('parses .gitignore-style rule content into normalized rule records', () => {
    const ruleSource: ResolvedIgnoreFile = {
      scope: 'workspace-folder',
      workspaceFolderPath: path.join('c:\\workspace', 'app'),
      ignoreFilePath: path.join('c:\\workspace', 'app', '.fast-indexer-ignore'),
      ruleBasePath: path.join('c:\\workspace', 'app')
    };

    const rules = parseIgnoreFileContent(`
# comment

generated/
!generated/keep.ts
*.snap
`.trim(), ruleSource);

    assert.deepEqual(rules, [
      {
        sourcePath: ruleSource.ignoreFilePath,
        ruleBasePath: ruleSource.ruleBasePath,
        pattern: 'generated',
        negated: false,
        directoryOnly: true
      },
      {
        sourcePath: ruleSource.ignoreFilePath,
        ruleBasePath: ruleSource.ruleBasePath,
        pattern: 'generated/keep.ts',
        negated: true,
        directoryOnly: false
      },
      {
        sourcePath: ruleSource.ignoreFilePath,
        ruleBasePath: ruleSource.ruleBasePath,
        pattern: '*.snap',
        negated: false,
        directoryOnly: false
      }
    ]);
  });

  test('treats leading-slash ignore rules as workspace-root anchored patterns', () => {
    const ruleSource: ResolvedIgnoreFile = {
      scope: 'workspace-folder',
      workspaceFolderPath: path.join('c:\\workspace', 'app'),
      ignoreFilePath: path.join('c:\\workspace', 'app', '.fast-indexer-ignore'),
      ruleBasePath: path.join('c:\\workspace', 'app')
    };

    const rules = parseIgnoreFileContent(`
/generated/
!/generated/keep.ts
/dist/*.js
`.trim(), ruleSource);

    assert.deepEqual(rules, [
      {
        sourcePath: ruleSource.ignoreFilePath,
        ruleBasePath: ruleSource.ruleBasePath,
        pattern: 'generated',
        negated: false,
        directoryOnly: true
      },
      {
        sourcePath: ruleSource.ignoreFilePath,
        ruleBasePath: ruleSource.ruleBasePath,
        pattern: 'generated/keep.ts',
        negated: true,
        directoryOnly: false
      },
      {
        sourcePath: ruleSource.ignoreFilePath,
        ruleBasePath: ruleSource.ruleBasePath,
        pattern: 'dist/*.js',
        negated: false,
        directoryOnly: false
      }
    ]);
  });

  test('merges built-in excludes, explicit exclude globs, and ignore-file rules into one matcher', () => {
    const ruleSource: ResolvedIgnoreFile = {
      scope: 'workspace-folder',
      workspaceFolderPath: path.join('c:\\workspace', 'app'),
      ignoreFilePath: path.join('c:\\workspace', 'app', '.fast-indexer-ignore'),
      ruleBasePath: path.join('c:\\workspace', 'app')
    };
    const rules = parseIgnoreFileContent(`
generated/
!generated/keep.ts
!dist/keep.js
*.snap
`.trim(), ruleSource);
    const matcher = createIgnoreMatcher({
      exclude: ['dist/**'],
      ignoreRules: rules
    });

    assert.equal(
      matcher.ignores(path.join('c:\\workspace', 'app', 'generated', 'value.ts'), 'generated/value.ts'),
      true
    );
    assert.equal(
      matcher.ignores(path.join('c:\\workspace', 'app', 'generated', 'keep.ts'), 'generated/keep.ts'),
      false
    );
    assert.equal(
      matcher.ignores(path.join('c:\\workspace', 'app', 'notes.snap'), 'notes.snap'),
      true
    );
    assert.equal(
      matcher.ignores(path.join('c:\\workspace', 'app', 'dist', 'keep.js'), 'dist/keep.js'),
      true
    );
    assert.equal(
      matcher.ignores(path.join('c:\\workspace', 'app', 'node_modules', 'pkg', 'index.js'), 'node_modules/pkg/index.js'),
      true
    );
    assert.equal(
      matcher.ignores(path.join('c:\\workspace', 'app', '.vscode-test', 'user-data', 'CachedData', 'chrome', 'js', 'cache_0'), '.vscode-test/user-data/CachedData/chrome/js/cache_0'),
      true
    );
    assert.equal(
      matcher.ignores(path.join('c:\\workspace', 'app', '.worktrees', 'add-command-mode-cycling', '.vscode-test', 'resources', 'app', 'node_modules.asar'), '.worktrees/add-command-mode-cycling/.vscode-test/resources/app/node_modules.asar'),
      true
    );
  });

  test('applies shared ignore files relative to the workspace root even when the file lives in a nested config directory', () => {
    const ruleSource: ResolvedIgnoreFile = {
      scope: 'workspace',
      ignoreFilePath: path.join('c:\\workspace', '.config', 'fast-indexer', 'shared.ignore'),
      ruleBasePath: path.join('c:\\workspace')
    };
    const rules = parseIgnoreFileContent(`
/generated/
!generated/keep.ts
`.trim(), ruleSource);
    const matcher = createIgnoreMatcher({
      exclude: [],
      ignoreRules: rules
    });

    assert.equal(
      matcher.ignores(path.join('c:\\workspace', 'generated', 'value.ts'), 'generated/value.ts'),
      true
    );
    assert.equal(
      matcher.ignores(path.join('c:\\workspace', 'generated', 'keep.ts'), 'generated/keep.ts'),
      false
    );
  });
});
