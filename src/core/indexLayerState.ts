import type { IndexLayer, PersistedLayerState } from '../shared/types';

const LAYER_ORDER: IndexLayer[] = ['file', 'text', 'symbol', 'semantic'];

export type LayerAvailability = {
  availableLayers: Set<IndexLayer>;
  activeLayer?: IndexLayer;
};

export function createLayerAvailability(
  availableLayers: IndexLayer[] = [],
  activeLayer?: IndexLayer
): LayerAvailability {
  return {
    availableLayers: new Set(availableLayers),
    activeLayer
  };
}

export function hasLayer(state: LayerAvailability, layer: IndexLayer): boolean {
  return state.availableLayers.has(layer);
}

export function markLayerAvailable(state: LayerAvailability, layer: IndexLayer): LayerAvailability {
  const next = new Set(state.availableLayers);
  next.add(layer);
  return { availableLayers: next, activeLayer: undefined };
}

export function markLayerActive(state: LayerAvailability, layer: IndexLayer): LayerAvailability {
  return {
    availableLayers: new Set(state.availableLayers),
    activeLayer: layer
  };
}

export function mergeLayerAvailability(state: LayerAvailability, layers: IndexLayer[]): LayerAvailability {
  const next = new Set(state.availableLayers);
  layers.forEach((layer) => next.add(layer));
  return { availableLayers: next, activeLayer: state.activeLayer };
}

export function toPersistedLayerState(state: LayerAvailability): PersistedLayerState {
  return {
    availableLayers: LAYER_ORDER.filter((layer) => state.availableLayers.has(layer)),
    activeLayer: state.activeLayer
  };
}
