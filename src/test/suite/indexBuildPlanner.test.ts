import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  createIndexBuildPlan,
  type IndexCandidate,
  type IndexReuseHints
} from '../../core/indexBuildPlanner';
import {
  createLayerAvailability,
  hasLayer,
  mergeLayerAvailability
} from '../../core/indexLayerState';

suite('indexBuildPlanner', () => {
  test('keeps reused files out of pending text and symbol work queues', () => {
    const candidates: IndexCandidate[] = [
      {
        uri: vscode.Uri.file('c:\\workspace\\src\\alpha.ts'),
        relativePath: 'src/alpha.ts'
      },
      {
        uri: vscode.Uri.file('c:\\workspace\\src\\beta.ts'),
        relativePath: 'src/beta.ts'
      }
    ];
    const reuseHints: IndexReuseHints = {
      file: new Set(['src/alpha.ts']),
      text: new Set(['src/alpha.ts']),
      symbol: new Set()
    };

    const plan = createIndexBuildPlan(candidates, reuseHints);

    assert.deepEqual(plan.filePhase.map((entry) => entry.relativePath), ['src/beta.ts']);
    assert.deepEqual(plan.textPhase.map((entry) => entry.relativePath), ['src/beta.ts']);
    assert.deepEqual(plan.symbolPhase.map((entry) => entry.relativePath), ['src/alpha.ts', 'src/beta.ts']);
  });

  test('merges restored layers without losing previously available capabilities', () => {
    const restored = createLayerAvailability(['file']);
    const merged = mergeLayerAvailability(restored, ['text']);

    assert.equal(hasLayer(merged, 'file'), true);
    assert.equal(hasLayer(merged, 'text'), true);
    assert.equal(hasLayer(merged, 'symbol'), false);
  });
});
