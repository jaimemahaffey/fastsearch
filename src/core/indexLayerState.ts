import type { IndexLayer, PersistedLayerState } from '../shared/types';

export type LayerAvailability = {
  availableLayers: Set<IndexLayer>;
  activeLayer?: IndexLayer;
};

export function createLayerAvailability(availableLayers: IndexLayer[] = [], activeLayer?: IndexLayer): LayerAvailability {
  return activeLayer
    ? {
        availableLayers: new Set(availableLayers),
        activeLayer
      }
    : {
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

export function markLayerActive(state: LayerAvailability, layer: IndexLayer): LayerAvailability {
  return {
    availableLayers: new Set(state.availableLayers),
    activeLayer: layer
  };
}

export function mergeLayerAvailability(state: LayerAvailability, layers: IndexLayer[]): LayerAvailability {
  const next = new Set(state.availableLayers);
  layers.forEach((layer) => next.add(layer));
  return { availableLayers: next };
}

export function toPersistedLayerState(state: LayerAvailability): PersistedLayerState {
  return state.activeLayer
    ? {
        availableLayers: Array.from(state.availableLayers),
        activeLayer: state.activeLayer
      }
    : {
        availableLayers: Array.from(state.availableLayers)
      };
}
