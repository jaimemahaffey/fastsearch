import type { FastIndexerConfig } from '../configuration';
import type { FileIndex } from '../indexes/fileIndex';
import type { SymbolIndex } from '../indexes/symbolIndex';
import type { TextIndex } from '../indexes/textIndex';
import { goToFile } from './goToFile';
import { goToSymbol } from './goToSymbol';
import { goToText } from './goToText';

type SearchMode = 'symbol' | 'text' | 'file';

type ModePresentation = {
  title: string;
  placeholder: string;
};

const SEARCH_MODE_SEQUENCE: SearchMode[] = ['symbol', 'text', 'file'];
const MODE_PRESENTATION: Record<SearchMode, ModePresentation> = {
  symbol: {
    title: 'Fast Indexer: Symbol Mode',
    placeholder: 'Search indexed symbols (symbol mode)'
  },
  text: {
    title: 'Fast Indexer: Text Mode',
    placeholder: 'Search indexed text (text mode)'
  },
  file: {
    title: 'Fast Indexer: File Mode',
    placeholder: 'Search indexed files (file mode)'
  }
};

function nextSearchMode(currentMode?: SearchMode): SearchMode {
  if (!currentMode) {
    return 'symbol';
  }

  const currentIndex = SEARCH_MODE_SEQUENCE.indexOf(currentMode);
  return SEARCH_MODE_SEQUENCE[(currentIndex + 1) % SEARCH_MODE_SEQUENCE.length]!;
}

export function createCycleSearchModeCommand(
  fileIndex: FileIndex,
  textIndex: TextIndex,
  symbolIndex: SymbolIndex,
  getConfig: () => FastIndexerConfig
): { execute: () => Promise<void>; reset: () => void; } {
  let activeMode: SearchMode | undefined;

  const reset = (): void => {
    activeMode = undefined;
  };

  const execute = async (): Promise<void> => {
    const mode = nextSearchMode(activeMode);
    activeMode = mode;

    const config = getConfig();
    const behavior = { ...config, completionStyleResults: true };
    const presentation = {
      ...MODE_PRESENTATION[mode],
      onDidHide: reset
    };
    let opened = false;

    if (mode === 'symbol') {
      opened = await goToSymbol(symbolIndex, behavior, {}, presentation);
    } else if (mode === 'text') {
      opened = await goToText(textIndex, behavior, {}, presentation);
    } else {
      opened = await goToFile(fileIndex, behavior, {}, presentation);
    }

    if (!opened) {
      reset();
    }
  };

  return { execute, reset };
}
