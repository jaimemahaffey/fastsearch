import * as assert from 'node:assert/strict';
import {
  createLayerAvailability,
  hasLayer,
  mergeLayerAvailability
} from '../../core/indexLayerState';

suite('indexLayerState', () => {
  test('tracks only available layers in memory', () => {
    const state = createLayerAvailability(['file']);

    assert.deepEqual(state, {
      availableLayers: new Set(['file'])
    });
    assert.equal(hasLayer(state, 'file'), true);
  });

  test('merges restored layers without adding transient build metadata', () => {
    const restored = createLayerAvailability(['file']);
    const merged = mergeLayerAvailability(restored, ['text']);

    assert.deepEqual(merged, {
      availableLayers: new Set(['file', 'text'])
    });
    assert.equal(hasLayer(merged, 'symbol'), false);
  });
});
