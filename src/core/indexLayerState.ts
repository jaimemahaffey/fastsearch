import type { IndexLayer } from '../shared/types';

export type LayerAvailability = {
  availableLayers: Set<IndexLayer>;
};

export function createLayerAvailability(availableLayers: IndexLayer[] = []): LayerAvailability {
  return {
    availableLayers: new Set(availableLayers)
  };
}

export function hasLayer(state: LayerAvailability, layer: IndexLayer): boolean {
  return state.availableLayers.has(layer);
}

export function markLayerAvailable(state: LayerAvailability, layer: IndexLayer): LayerAvailability {
  const next = new Set(state.availableLayers);
  next.add(layer);
  return { availableLayers: next };
}

export function mergeLayerAvailability(state: LayerAvailability, layers: IndexLayer[]): LayerAvailability {
  const next = new Set(state.availableLayers);
  layers.forEach((layer) => next.add(layer));
  return { availableLayers: next };
}
