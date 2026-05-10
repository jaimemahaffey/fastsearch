import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  createSymbolHydrationPlan,
  type SymbolHydrationCandidate
} from '../../core/symbolHydrationPlan';

function candidate(relativePath: string): SymbolHydrationCandidate {
  return {
    uri: vscode.Uri.file(`c:\\workspace\\${relativePath.replace(/\//g, '\\')}`),
    relativePath,
    contentHash: `${relativePath}-hash`
  };
}

suite('symbolHydrationPlan', () => {
  test('prioritizes open files before changed files and background files', () => {
    const plan = createSymbolHydrationPlan(
      [
        candidate('keyboards/planck/keymaps/default/keymap.c'),
        candidate('quantum/action.c'),
        candidate('docs/readme.md')
      ],
      {
        openPaths: new Set(['docs/readme.md']),
        changedPaths: new Set(['quantum/action.c']),
        hydratedPaths: new Set()
      }
    );

    assert.deepEqual(plan.items.map((item) => item.relativePath), [
      'docs/readme.md',
      'quantum/action.c',
      'keyboards/planck/keymaps/default/keymap.c'
    ]);
    assert.deepEqual(plan.items.map((item) => item.reason), ['open', 'changed', 'breadth']);
  });

  test('does not queue paths that already have reusable hydrated symbols', () => {
    const plan = createSymbolHydrationPlan(
      [
        candidate('quantum/action.c'),
        candidate('quantum/keycode.c')
      ],
      {
        openPaths: new Set(),
        changedPaths: new Set(),
        hydratedPaths: new Set(['quantum/action.c'])
      }
    );

    assert.deepEqual(plan.items.map((item) => item.relativePath), ['quantum/keycode.c']);
  });

  test('matches Windows-style candidates against normalized open paths', () => {
    const plan = createSymbolHydrationPlan(
      [candidate('src\\openFile.ts')],
      {
        openPaths: new Set(['src/openFile.ts']),
        changedPaths: new Set(),
        hydratedPaths: new Set()
      }
    );

    assert.equal(plan.items[0].relativePath, 'src\\openFile.ts');
    assert.equal(plan.items[0].reason, 'open');
  });

  test('matches Windows-style candidates against normalized changed paths', () => {
    const plan = createSymbolHydrationPlan(
      [candidate('src\\changedFile.ts')],
      {
        openPaths: new Set(),
        changedPaths: new Set(['src/changedFile.ts']),
        hydratedPaths: new Set()
      }
    );

    assert.equal(plan.items[0].relativePath, 'src\\changedFile.ts');
    assert.equal(plan.items[0].reason, 'changed');
  });

  test('excludes Windows-style candidates that match normalized hydrated paths', () => {
    const plan = createSymbolHydrationPlan(
      [
        candidate('src\\alreadyHydrated.ts'),
        candidate('src\\needsHydration.ts')
      ],
      {
        openPaths: new Set(),
        changedPaths: new Set(),
        hydratedPaths: new Set(['src/alreadyHydrated.ts'])
      }
    );

    assert.deepEqual(plan.items.map((item) => item.relativePath), ['src\\needsHydration.ts']);
  });

  test('uses breadth-first ordering for background coverage', () => {
    const plan = createSymbolHydrationPlan(
      [
        candidate('keyboards/vendor/board/keymaps/default/keymap.c'),
        candidate('quantum/action.c'),
        candidate('drivers/gpio.c')
      ],
      {
        openPaths: new Set(),
        changedPaths: new Set(),
        hydratedPaths: new Set()
      }
    );

    assert.deepEqual(plan.items.map((item) => item.relativePath), [
      'drivers/gpio.c',
      'quantum/action.c',
      'keyboards/vendor/board/keymaps/default/keymap.c'
    ]);
  });

  test('normalizes Windows-style separators for breadth-first ordering', () => {
    const plan = createSymbolHydrationPlan(
      [
        candidate('keyboards\\planck\\keymaps\\default\\keymap.c'),
        candidate('quantum/action.c'),
        candidate('drivers/gpio.c')
      ],
      {
        openPaths: new Set(),
        changedPaths: new Set(),
        hydratedPaths: new Set()
      }
    );

    assert.deepEqual(plan.items.map((item) => item.relativePath), [
      'drivers/gpio.c',
      'quantum/action.c',
      'keyboards\\planck\\keymaps\\default\\keymap.c'
    ]);
  });
});
