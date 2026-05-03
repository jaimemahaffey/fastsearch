import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { detectCommandSearchTools, runExternalTool } from '../../externalTools/commandSearchTools';
import { narrowCommandSearchCandidatesWithFzf, searchTextWithRipgrep } from '../../externalTools/commandSearchProviders';
import type { CommandSearchCandidate } from '../../shared/commandSearch';
import { patchProperty, restoreProperty } from './helpers/propertyPatch';

suite('externalTools', () => {
  test('detects rg and fzf availability independently', async () => {
    const availability = await detectCommandSearchTools(async (tool) => tool === 'rg');

    assert.deepEqual(availability, {
      rg: true,
      fzf: false
    });
  });

  test('returns safe fallback results when an external tool is disabled, missing, or fails', async () => {
    const disabled = await runExternalTool(
      'rg',
      ['alpha'],
      { enabled: false },
      async () => {
        throw new Error('runner should not be called');
      }
    );
    const missing = await runExternalTool(
      'fzf',
      ['--filter', 'alpha'],
      { enabled: true },
      async () => {
        const error = new Error('spawn ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
    );
    const failed = await runExternalTool(
      'rg',
      ['alpha'],
      { enabled: true, input: 'alpha\nbeta' },
      async (_tool, _args, input) => {
        assert.equal(input, 'alpha\nbeta');
        return {
          exitCode: 2,
          stdout: '',
          stderr: 'bad args'
        };
      }
    );

    assert.deepEqual(disabled, {
      ok: false,
      tool: 'rg',
      reason: 'disabled'
    });
    assert.deepEqual(missing, {
      ok: false,
      tool: 'fzf',
      reason: 'missing'
    });
    assert.deepEqual(failed, {
      ok: false,
      tool: 'rg',
      reason: 'failed',
      stderr: 'bad args'
    });
  });

  test('returns stdout when an external tool succeeds', async () => {
    const result = await runExternalTool(
      'rg',
      ['alpha'],
      { enabled: true },
      async () => ({
        exitCode: 0,
        stdout: 'src/app.ts:alpha',
        stderr: ''
      })
    );

    assert.deepEqual(result, {
      ok: true,
      tool: 'rg',
      stdout: 'src/app.ts:alpha',
      stderr: ''
    });
  });

  test('treats configured non-zero exit codes as successful tool execution', async () => {
    const result = await runExternalTool(
      'rg',
      ['alpha'],
      { enabled: true, allowedExitCodes: [1] },
      async () => ({
        exitCode: 1,
        stdout: '',
        stderr: ''
      })
    );

    assert.deepEqual(result, {
      ok: true,
      tool: 'rg',
      stdout: '',
      stderr: ''
    });
  });

  test('collects text matches from ripgrep json output', async () => {
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [
      {
        uri: vscode.Uri.file('c:\\workspace'),
        index: 0,
        name: 'workspace'
      }
    ] as typeof vscode.workspace.workspaceFolders);
    const relativePathPatch = patchProperty(vscode.workspace, 'asRelativePath', ((resource: string | vscode.Uri) => {
      return typeof resource === 'string' ? resource : 'src/app/rg-match.ts';
    }) as typeof vscode.workspace.asRelativePath);

    try {
      const matches = await searchTextWithRipgrep(
        'beta',
        { enabled: true },
        async (_tool, args) => {
          assert.ok(args.includes('--json'));
          assert.ok(args.includes('--fixed-strings'));
          assert.ok(args.includes('beta'));
          assert.ok(args.includes('c:\\workspace'));
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({
              type: 'match',
              data: {
                path: { text: 'c:\\workspace\\src\\app\\rg-match.ts' },
                lines: { text: 'export const beta = alpha + 1;\n' },
                line_number: 3,
                submatches: [{ start: 13, end: 17, match: { text: 'beta' } }]
              }
            })}\n`,
            stderr: ''
          };
        }
      );

      assert.deepEqual(matches, [
        {
          relativePath: 'src/app/rg-match.ts',
          uri: vscode.Uri.file('c:\\workspace\\src\\app\\rg-match.ts').toString(),
          line: 3,
          column: 14,
          preview: 'export const beta = alpha + 1;'
        }
      ]);
    } finally {
      restoreProperty(relativePathPatch);
      restoreProperty(workspaceFoldersPatch);
    }
  });

  test('returns no ripgrep matches when the binary is missing', async () => {
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [
      {
        uri: vscode.Uri.file('c:\\workspace'),
        index: 0,
        name: 'workspace'
      }
    ] as typeof vscode.workspace.workspaceFolders);

    try {
      const matches = await searchTextWithRipgrep(
        'beta',
        { enabled: true },
        async () => {
          const error = new Error('spawn ENOENT') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        }
      );

      assert.deepEqual(matches, []);
    } finally {
      restoreProperty(workspaceFoldersPatch);
    }
  });

  test('narrows candidates with fzf output while preserving VS Code ownership of the UI', async () => {
    const candidates: CommandSearchCandidate[] = [
      {
        source: 'file',
        label: 'go-to-text.ts',
        description: 'src/app/go-to-text.ts',
        detail: 'Indexed file',
        filterText: 'go to text src/app/go-to-text.ts',
        uri: vscode.Uri.file('c:\\workspace\\src\\app\\go-to-text.ts').toString(),
        approximate: false
      },
      {
        source: 'file',
        label: 'go-to-file.ts',
        description: 'src/app/go-to-file.ts',
        detail: 'Indexed file',
        filterText: 'go to file src/app/go-to-file.ts',
        uri: vscode.Uri.file('c:\\workspace\\src\\app\\go-to-file.ts').toString(),
        approximate: false
      }
    ];

    const narrowed = await narrowCommandSearchCandidatesWithFzf(
      'gt',
      candidates,
      { enabled: true },
      async (tool, args, input) => {
        assert.equal(tool, 'fzf');
        assert.ok(args.includes('--filter'));
        assert.equal(input, [
          `0\t${candidates[0].filterText}`,
          `1\t${candidates[1].filterText}`
        ].join('\n'));
        return {
          exitCode: 0,
          stdout: `1\t${candidates[1].filterText}\n0\t${candidates[0].filterText}\n`,
          stderr: ''
        };
      }
    );

    assert.deepEqual(narrowed.map((candidate) => candidate.label), [
      'go-to-file.ts',
      'go-to-text.ts'
    ]);
  });

  test('falls back to the built-in candidate ordering when fzf is missing', async () => {
    const candidates: CommandSearchCandidate[] = [
      {
        source: 'file',
        label: 'go-to-file.ts',
        description: 'src/app/go-to-file.ts',
        detail: 'Indexed file',
        filterText: 'go to file src/app/go-to-file.ts',
        uri: vscode.Uri.file('c:\\workspace\\src\\app\\go-to-file.ts').toString(),
        approximate: false
      },
      {
        source: 'file',
        label: 'go-to-text.ts',
        description: 'src/app/go-to-text.ts',
        detail: 'Indexed file',
        filterText: 'go to text src/app/go-to-text.ts',
        uri: vscode.Uri.file('c:\\workspace\\src\\app\\go-to-text.ts').toString(),
        approximate: false
      }
    ];

    const narrowed = await narrowCommandSearchCandidatesWithFzf(
      'gt',
      candidates,
      { enabled: true },
      async () => {
        const error = new Error('spawn ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
    );

    assert.deepEqual(narrowed.map((candidate) => candidate.label), [
      'go-to-file.ts',
      'go-to-text.ts'
    ]);
  });
});
