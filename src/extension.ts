import * as path from 'node:path';
import * as vscode from 'vscode';
import { getDeclarations, getDefinitions, getDocumentSymbols, getHoverSummary, getImplementationsAt, getReferencesAt, getTypeDefinitions } from './bridge/providerBridge';
import { createCycleSearchModeCommand } from './commands/cycleSearchMode';
import { findImplementations } from './commands/findImplementations';
import { findUsages } from './commands/findUsages';
import { goToFile } from './commands/goToFile';
import { rebuildIndex } from './commands/rebuildIndex';
import { goToSymbol } from './commands/goToSymbol';
import { goToText } from './commands/goToText';
import { readConfig, requiresRebuild } from './configuration';
import { createIndexBenchmarkRecorder } from './core/indexBenchmarkRecorder';
import { createIndexBuildPlan } from './core/indexBuildPlanner';
import { hashContent } from './core/contentHash';
import { IndexCoordinator, shouldYield } from './core/indexCoordinator';
import { createLayerAvailability, hasLayer, markLayerActive, markLayerAvailable, toPersistedLayerState } from './core/indexLayerState';
import { runPhaseJobs } from './core/indexPhaseRunner';
import { createIgnoreMatcher, loadConfiguredIgnoreMatcher, type IgnoreMatcher } from './core/ignoreRules';
import { buildMerkleTree, diffMerkleLeaves, type MerkleLeafRecord, type MerkleTreeSnapshot } from './core/merkleTree';
import { toPersistedSubtreeHashes, type PersistedMerkleSnapshot } from './core/merkleSnapshot';
import { PersistenceStore, type PersistedWorkspaceSnapshot } from './core/persistenceStore';
import { createSymbolHydrationPlan, type SymbolHydrationPlanItem } from './core/symbolHydrationPlan';
import { SymbolHydrationScheduler, type SymbolHydrationWorkerResult } from './core/symbolHydrationScheduler';
import { shouldProcessUpdateJob, WORKSPACE_FILE_EXCLUDE_GLOB, type UpdateJob, type WatcherPathFilters } from './core/workspaceWatcher';
import { FileIndex } from './indexes/fileIndex';
import { SymbolIndex } from './indexes/symbolIndex';
import { TextIndex } from './indexes/textIndex';
import { SemanticEnrichmentService } from './semantics/semanticEnrichmentService';
import { SemanticIndex } from './semantics/semanticIndex';
import { isEligibleTextFile } from './shared/fileEligibility';
import type { FastIndexerConfig } from './configuration';
import type { IndexLayer, WorkspacePersistence } from './shared/types';

const INITIAL_INDEXES_WARMING_MESSAGE = 'Building initial indexes. Please wait a moment.';
const INITIAL_FILE_LAYER_WARMING_MESSAGE = 'Building initial file index. Please wait a moment.';
const INITIAL_TEXT_LAYER_WARMING_MESSAGE = 'Building initial text index. Please wait a moment.';
const INITIAL_SYMBOL_LAYER_WARMING_MESSAGE = 'Building initial symbol index. Please wait a moment.';
const INITIAL_INDEX_REBUILD_BLOCKED_MESSAGE = 'Initial index build is still running. Please wait for it to finish before rebuilding.';
const PARTIAL_SYMBOL_INDEX_MESSAGE = 'Partial symbol index; background hydration is still running.';
const INDEXING_DISABLED_MESSAGE = 'Fast Symbol Indexer indexing is disabled.';
const INDEX_BUILD_YIELD_INTERVAL = 50;
const INDEX_BUILD_STATUS_PRIORITY = 100;
const PERSISTENCE_SCHEMA_VERSION = 2;
const TEXT_PHASE_CONCURRENCY = 8;
const TEXT_HYDRATION_BATCH_SIZE = 100;
const SYMBOL_PHASE_CONCURRENCY = 1;
const SYMBOL_HYDRATION_BATCH_SIZE = 25;

type IndexBuildKind = 'initial' | 'rebuild';

type WorkspaceMerkleEntry = MerkleLeafRecord & {
  textContent?: string;
};

type WorkspaceCandidate = {
  uri: vscode.Uri;
  relativePath: string;
};

type BuildWorkspaceIndexesResult = {
  completed: boolean;
  canPersistSnapshot: boolean;
  merkle?: MerkleTreeSnapshot;
  pendingSymbolHydration?: {
    items: SymbolHydrationPlanItem[];
    generation: number;
  };
};

type PersistCheckpoint = (
  merkleSnapshot: MerkleTreeSnapshot,
  activeLayer?: IndexLayer,
  shouldPersist?: () => boolean
) => Promise<void>;
type InvalidateLayers = (layers: IndexLayer[]) => void;

type IndexBuildProgress = {
  phase: 'discovering' | 'indexing';
  kind: IndexBuildKind;
  currentLayer?: IndexLayer;
  processedFiles: number;
  totalFiles?: number;
  skippedFiles: number;
  symbolTimeouts: number;
  currentFile?: string;
  startedAt: number;
};

type IndexBuildStatusReporter = {
  start: (token: number, kind: IndexBuildKind) => void;
  setTotalFiles: (token: number, totalFiles: number) => void;
  advance: (
    token: number,
    update: Pick<IndexBuildProgress, 'processedFiles' | 'skippedFiles' | 'symbolTimeouts' | 'currentFile' | 'currentLayer'>
  ) => void;
  finish: (token: number) => void;
};

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Fast Symbol Indexer');
  const buildStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, INDEX_BUILD_STATUS_PRIORITY);
  const buildStatus = createIndexBuildStatusReporter(buildStatusItem);
  const benchmarkRecorder = createIndexBenchmarkRecorder(process.env.FASTSEARCH_BENCHMARK_PATH);
  const benchmarkStartedAt = Date.now();
  let benchmarkedLayers = new Set<IndexLayer>();
  let symbolHydrationCompleteBenchmarked = false;
  const benchmarkElapsedMs = (): number => Date.now() - benchmarkStartedAt;
  const flushBenchmark = (): void => {
    if (!benchmarkRecorder.enabled) {
      return;
    }

    void benchmarkRecorder.flush().catch((error) => {
      output.appendLine(`Failed to write indexing benchmark events: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const recordBenchmarkEvent = (event: 'fileReady' | 'textReady' | 'symbolUsable' | 'symbolComplete' | 'symbolBatch', count?: number): void => {
    if (!benchmarkRecorder.enabled) {
      return;
    }

    benchmarkRecorder.record({
      event,
      elapsedMs: benchmarkElapsedMs(),
      ...(count === undefined ? {} : { count })
    });
    flushBenchmark();
  };
  const resetLayerBenchmarkEvents = (): void => {
    benchmarkedLayers = new Set<IndexLayer>();
    symbolHydrationCompleteBenchmarked = false;
  };
  const recordLayerBenchmarkEvent = (layer: IndexLayer): void => {
    if (benchmarkedLayers.has(layer)) {
      return;
    }

    benchmarkedLayers.add(layer);
    if (layer === 'file') {
      recordBenchmarkEvent('fileReady');
      return;
    }

    if (layer === 'text') {
      recordBenchmarkEvent('textReady');
      return;
    }

    if (layer === 'symbol') {
      recordBenchmarkEvent('symbolUsable');
    }
  };
  const recordAvailableLayerBenchmarkEvents = (): void => {
    for (const layer of ['file', 'text', 'symbol'] as const) {
      if (hasLayer(layerAvailability, layer)) {
        recordLayerBenchmarkEvent(layer);
      }
    }
  };
  const getConfig = () => readConfig();
  const config = getConfig();
  const fileIndex = new FileIndex();
  const symbolIndex = new SymbolIndex();
  const textIndex = new TextIndex();
  const semanticIndex = new SemanticIndex();
  let semanticService = createSemanticService(semanticIndex, config, output);
  const persistenceStore = new PersistenceStore(context.globalStorageUri?.fsPath ?? context.storageUri?.fsPath ?? '.fast-indexer-cache');
  const workspacePersistence = getWorkspacePersistence();
  let activeIgnoreMatcher: IgnoreMatcher = createIgnoreMatcher({
    exclude: config.exclude,
    ignoreRules: []
  });
  let activePersistenceConfigHash = createPersistenceConfigHash(config, []);
  let configuredIgnoreFilePaths = new Set<string>();
  let buildGeneration = 0;
  let workspaceMerkleState: MerkleTreeSnapshot | undefined;
  let workspaceMerkleGeneration = 0;
  let activeBuildMerkleState: MerkleTreeSnapshot | undefined;
  let activeBuildMerkleGeneration = 0;
  let pendingUpdateJobs: UpdateJob[] = [];
  let symbolHydrationScheduler: SymbolHydrationScheduler | undefined;
  const clearActiveBuildMerkleState = (): void => {
    activeBuildMerkleState = undefined;
    activeBuildMerkleGeneration = 0;
  };
  const enqueueSymbolHydration = (items: SymbolHydrationPlanItem[], generation: number): void => {
    const scheduler = symbolHydrationScheduler;
    const recordSymbolHydrationComplete = (): void => {
      if (
        symbolHydrationCompleteBenchmarked
        || generation !== buildGeneration
        || !scheduler
        || symbolHydrationScheduler !== scheduler
        || !isSymbolHydrationComplete()
      ) {
        return;
      }

      symbolHydrationCompleteBenchmarked = true;
      recordBenchmarkEvent('symbolComplete');
    };

    if (!scheduler) {
      return;
    }

    if (items.length === 0) {
      queueMicrotask(recordSymbolHydrationComplete);
      return;
    }

    scheduler.enqueue(items, generation);
    void scheduler.drain()
      .then(() => {
        recordSymbolHydrationComplete();
      })
      .catch((error) => {
        output.appendLine(`Failed to hydrate workspace symbols: ${error instanceof Error ? error.message : String(error)}`);
      });
  };
  const resetSymbolHydrationScheduler = (): void => {
    symbolHydrationScheduler?.cancel();
    symbolHydrationScheduler = createWorkspaceSymbolHydrationScheduler();
  };
  const refreshIgnoreMatcher = async (): Promise<IgnoreMatcher> => {
    const loadedIgnoreMatcher = await loadConfiguredIgnoreMatcher(
      vscode.workspace.fs,
      getConfig(),
      vscode.workspace.workspaceFolders ?? [],
      vscode.workspace.workspaceFile
    );
    loadedIgnoreMatcher.diagnostics.forEach((message) => output.appendLine(message));
    activeIgnoreMatcher = loadedIgnoreMatcher.matcher;
    activePersistenceConfigHash = createPersistenceConfigHash(getConfig(), loadedIgnoreMatcher.persistenceInputs);
    configuredIgnoreFilePaths = new Set(
      loadedIgnoreMatcher.resolvedIgnoreFiles.map((entry) => normalizeWorkspaceFilePath(entry.ignoreFilePath))
    );
    return loadedIgnoreMatcher.matcher;
  };
  const buildWorkspace = async () => {
    const progressToken = activeBuildProgressToken;
    const buildKind = currentBuildKind;
    buildStatus.start(progressToken, buildKind);
    const generation = ++buildGeneration;
    clearActiveBuildMerkleState();
    resetSymbolHydrationScheduler();

    try {
      const currentConfig = getConfig();
      const ignoreMatcher = await refreshIgnoreMatcher();
      const completed = await buildWorkspaceIndexesLayered(
        fileIndex,
        symbolIndex,
        textIndex,
        semanticIndex,
        semanticService,
        generation,
        currentConfig,
        ignoreMatcher,
        output,
        () => getConfig().enabled && generation === buildGeneration,
        buildStatus,
        progressToken,
        buildKind === 'initial' ? restoredSnapshot : undefined,
        (layer) => {
          layerAvailability = markLayerAvailable(layerAvailability, layer);
          recordLayerBenchmarkEvent(layer);
          resolveLayerWaiters(layer);
        },
        invalidateLayers,
        persistLayerCheckpoint,
        (merkle, merkleGeneration) => {
          if (merkleGeneration === buildGeneration) {
            activeBuildMerkleState = merkle;
            activeBuildMerkleGeneration = merkleGeneration;
          }
        },
        (merkle, merkleGeneration) =>
          getConfig().enabled
          && buildGeneration === merkleGeneration
          && activeBuildMerkleGeneration === merkleGeneration
          && activeBuildMerkleState === merkle,
      );

      workspaceMerkleState = completed.completed ? completed.merkle : undefined;
      workspaceMerkleGeneration = completed.completed && completed.merkle ? generation : 0;
      if (completed.completed && getConfig().enabled && completed.canPersistSnapshot && completed.merkle) {
        await persistLayerCheckpoint(completed.merkle);
      }
      if (
        completed.completed
        && getConfig().enabled
        && completed.pendingSymbolHydration
        && completed.pendingSymbolHydration.generation === buildGeneration
      ) {
        enqueueSymbolHydration(completed.pendingSymbolHydration.items, completed.pendingSymbolHydration.generation);
      }

      return completed.completed;
    } finally {
      buildStatus.finish(progressToken);
    }
  };
  const coordinator = new IndexCoordinator({
    clearIndexes: () => {
      resetSymbolHydrationScheduler();
      semanticService.cancelGeneration(buildGeneration);
      semanticService.clear();
      fileIndex.clear();
      symbolIndex.clear();
      textIndex.clear();
      semanticIndex.clear();
        workspaceMerkleState = undefined;
        workspaceMerkleGeneration = 0;
        clearActiveBuildMerkleState();
        pendingUpdateJobs = [];
      },
    clearPersistence: async () => persistenceStore.clearWorkspaceCache(workspacePersistence.workspaceId),
    buildWorkspace
  });
  let initialFileIndexBuildPending = config.enabled;
  let rebuildQueued = false;
  let rebuildInFlight = false;
  let rebuildTimeout: NodeJS.Timeout | undefined;
  let initialIndexPromise: Promise<void> = Promise.resolve();
  let initialSnapshotRestorePending = false;
  let initialSnapshotPromise: Promise<void> = Promise.resolve();
  let restoredSnapshotReady = false;
  let restoredSnapshot: PersistedWorkspaceSnapshot | undefined;
  let initialBuildToken = 0;
  let activeBuildProgressToken = 0;
  let currentBuildKind: IndexBuildKind = 'initial';
  let layerAvailability = createLayerAvailability();
  const layerWaiters = new Map<IndexLayer, Array<() => void>>();

  const resolveLayerWaiters = (layer: IndexLayer): void => {
    const waiters = layerWaiters.get(layer) ?? [];
    layerWaiters.delete(layer);
    waiters.forEach((resolve) => resolve());
  };

  const resolveAllLayerWaiters = (): void => {
    for (const layer of [...layerWaiters.keys()]) {
      resolveLayerWaiters(layer);
    }
  };
  const invalidateLayers: InvalidateLayers = (layers): void => {
    const unavailableLayers = new Set<IndexLayer>(layers);
    const availableLayers = [...layerAvailability.availableLayers].filter((layer) => !unavailableLayers.has(layer));
    const activeLayer = layerAvailability.activeLayer && !unavailableLayers.has(layerAvailability.activeLayer)
      ? layerAvailability.activeLayer
      : undefined;
    layerAvailability = createLayerAvailability(availableLayers, activeLayer);
  };

  const persistLayerCheckpoint = async (
    merkleSnapshot: MerkleTreeSnapshot,
    activeLayer?: IndexLayer,
    shouldPersist = () => getConfig().enabled
  ): Promise<void> => {
    if (!shouldPersist()) {
      return;
    }

    await persistenceStore.writeWorkspaceSnapshot(
      workspacePersistence.workspaceId,
      createPersistedWorkspaceSnapshot(
        workspacePersistence,
        activePersistenceConfigHash,
        fileIndex,
        symbolIndex,
        textIndex,
        semanticIndex,
        merkleSnapshot,
        toPersistedLayerState(activeLayer ? markLayerActive(layerAvailability, activeLayer) : layerAvailability)
      )
    );
  };
  symbolHydrationScheduler = createWorkspaceSymbolHydrationScheduler();

  const runQueuedRebuild = (): void => {
    if (initialFileIndexBuildPending || rebuildInFlight) {
      return;
    }

    rebuildQueued = false;
    rebuildTimeout = setTimeout(() => {
      rebuildTimeout = undefined;
      pendingUpdateJobs = [];
      rebuildInFlight = true;
      void coordinator.rebuild()
        .catch((error) => {
          output.appendLine(`Failed to refresh workspace indexes: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          rebuildInFlight = false;
          if (rebuildQueued) {
            runQueuedRebuild();
            return;
          }

          if (pendingUpdateJobs.length > 0) {
            runQueuedIncrementalUpdate();
          }
        });
    }, getConfig().debounceMs);
  };

  const queueWorkspaceRefresh = (): void => {
    if (!getConfig().enabled) {
      return;
    }

    pendingUpdateJobs = [];
    rebuildQueued = true;
    coordinator.markStale();

    if (rebuildTimeout) {
      clearTimeout(rebuildTimeout);
      rebuildTimeout = undefined;
    }

    runQueuedRebuild();
  };

  const applyIncrementalMerkleUpdates = async (
    jobs: UpdateJob[],
    generation: number,
    config: FastIndexerConfig,
    incrementalSemanticService: SemanticEnrichmentService
  ): Promise<boolean> => {
    if (!workspaceMerkleState) {
      return false;
    }

    const shouldContinue = () => getConfig().enabled && generation === buildGeneration;
    const merkleLeaves = new Map<string, WorkspaceMerkleEntry>(
      [...workspaceMerkleState.leavesByPath.entries()].map(([relativePath, leaf]) => [relativePath, { ...leaf }])
    );

    for (const job of jobs) {
      const relativePath = normalizeWorkspaceMerklePath(job.relativePath);
      if (job.type === 'delete') {
        removeWorkspaceFileEntries(relativePath, fileIndex, symbolIndex, textIndex, semanticIndex);
        merkleLeaves.delete(relativePath);
        continue;
      }

      if (!job.filePath) {
        throw new Error(`Missing file path for ${job.type} update on ${relativePath}`);
      }

      const file = vscode.Uri.file(job.filePath);
      let merkleEntry: WorkspaceMerkleEntry;
      try {
        merkleEntry = await readWorkspaceMerkleEntry(file, relativePath, config);
      } catch (error) {
        if (isMissingFileError(error)) {
          removeWorkspaceFileEntries(relativePath, fileIndex, symbolIndex, textIndex, semanticIndex);
          merkleLeaves.delete(relativePath);
          continue;
        }

        throw error;
      }
      const result = await reindexWorkspaceFile(
        file,
        relativePath,
        config,
        generation,
        output,
        shouldContinue,
        incrementalSemanticService,
        fileIndex,
        symbolIndex,
        textIndex,
        semanticIndex,
        merkleEntry.textContent
      );

      if (result.aborted) {
        return false;
      }

      merkleLeaves.set(relativePath, merkleEntry);
    }

    if (!shouldContinue()) {
      return false;
    }

    workspaceMerkleState = buildMerkleTree([...merkleLeaves.values()]);
    workspaceMerkleGeneration = generation;
    await persistenceStore.writeWorkspaceSnapshot(
      workspacePersistence.workspaceId,
      createPersistedWorkspaceSnapshot(
        workspacePersistence,
        activePersistenceConfigHash,
        fileIndex,
        symbolIndex,
        textIndex,
        semanticIndex,
        workspaceMerkleState
      )
    );

    return true;
  };

  const runQueuedIncrementalUpdate = (): void => {
    if (
      initialFileIndexBuildPending
      || rebuildInFlight
      || rebuildQueued
      || rebuildTimeout !== undefined
      || pendingUpdateJobs.length === 0
    ) {
      return;
    }

    if (!workspaceMerkleState) {
      queueWorkspaceRefresh();
      return;
    }

    const jobs = pendingUpdateJobs.splice(0, pendingUpdateJobs.length);
    coordinator.markStale();
    rebuildInFlight = true;
    semanticService.cancelGeneration(buildGeneration);
    buildGeneration += 1;
    clearActiveBuildMerkleState();
    resetSymbolHydrationScheduler();
    const generation = buildGeneration;
    const currentConfig = getConfig();
    semanticService = createSemanticService(semanticIndex, currentConfig, output);
    const incrementalSemanticService = semanticService;
    let needsFullRebuild = false;

    void applyIncrementalMerkleUpdates(jobs, generation, currentConfig, incrementalSemanticService)
      .then((completed) => {
        if (completed && getConfig().enabled && generation === buildGeneration) {
          coordinator.markReady();
          return;
        }

        needsFullRebuild = getConfig().enabled;
      })
      .catch((error) => {
        needsFullRebuild = getConfig().enabled;
        output.appendLine(`Failed to apply incremental workspace updates: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        rebuildInFlight = false;
        if (needsFullRebuild) {
          queueWorkspaceRefresh();
          return;
        }

        if (rebuildQueued) {
          runQueuedRebuild();
          return;
        }

        if (pendingUpdateJobs.length > 0) {
          runQueuedIncrementalUpdate();
        }
      });
  };

  const queueWorkspaceRefreshForJob = (job: UpdateJob): void => {
    if (job.filePath && configuredIgnoreFilePaths.has(normalizeWorkspaceFilePath(job.filePath))) {
      void refreshIgnoreMatcher()
        .catch((error) => {
          output.appendLine(`Failed to refresh ignore matcher: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          queueWorkspaceRefresh();
        });
      return;
    }

    if (!shouldProcessUpdateJob(job, getWatcherFilters(getConfig(), activeIgnoreMatcher))) {
      return;
    }

    if (rebuildQueued || rebuildTimeout !== undefined) {
      return;
    }

    pendingUpdateJobs.push({
      ...job,
      relativePath: normalizeWorkspaceMerklePath(job.relativePath)
    });
    runQueuedIncrementalUpdate();
  };

  const beginBuildGate = (runner: () => Promise<boolean | void>): void => {
    const buildToken = ++initialBuildToken;
    activeBuildProgressToken = buildToken;
    initialFileIndexBuildPending = true;
    initialIndexPromise = runner()
      .then((completed) => {
        if (buildToken !== initialBuildToken) {
          return;
        }

        if (completed === false || !getConfig().enabled) {
          coordinator.markStale();
          return;
        }

        coordinator.markReady();
      })
      .catch((error) => {
        if (buildToken !== initialBuildToken) {
          return;
        }

        coordinator.markStale();
        output.appendLine(`Failed to build workspace indexes: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (buildToken !== initialBuildToken) {
          return;
        }

        initialFileIndexBuildPending = false;
        resolveAllLayerWaiters();
        if (rebuildQueued) {
          runQueuedRebuild();
          return;
        }

        if (pendingUpdateJobs.length > 0) {
          runQueuedIncrementalUpdate();
        }
      });
  };

  const startInitialBuild = (): void => {
    currentBuildKind = 'initial';
    coordinator.markWarming();
    restoredSnapshotReady = false;
    layerAvailability = createLayerAvailability();
    resetLayerBenchmarkEvents();
    clearActiveBuildMerkleState();
    initialSnapshotRestorePending = true;
    initialSnapshotPromise = restorePersistedSnapshot(
      persistenceStore,
      workspacePersistence,
      refreshIgnoreMatcher,
      () => activePersistenceConfigHash,
      fileIndex,
      symbolIndex,
      textIndex,
      semanticIndex
    )
      .then((snapshot) => {
        restoredSnapshot = snapshot;
        layerAvailability = snapshot
          ? createLayerAvailability(
              snapshot.metadata.layerState?.availableLayers ?? ['file', 'text', 'symbol'],
              snapshot.metadata.layerState?.activeLayer
            )
          : createLayerAvailability();
        recordAvailableLayerBenchmarkEvents();
        restoredSnapshotReady = hasLayer(layerAvailability, 'file');
      })
      .catch((error) => {
        restoredSnapshot = undefined;
        restoredSnapshotReady = false;
        layerAvailability = createLayerAvailability();
        resetLayerBenchmarkEvents();
        output.appendLine(`Failed to restore persisted workspace snapshot: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        initialSnapshotRestorePending = false;
        beginBuildGate(buildWorkspace);
      });
  };

  const startConfigRebuild = (): void => {
    currentBuildKind = 'rebuild';
    if (rebuildTimeout) {
      clearTimeout(rebuildTimeout);
      rebuildTimeout = undefined;
    }

    rebuildQueued = false;
    pendingUpdateJobs = [];
    semanticService.cancelGeneration(buildGeneration);
    buildGeneration += 1;
    clearActiveBuildMerkleState();
    resetSymbolHydrationScheduler();
    semanticService = createSemanticService(semanticIndex, getConfig(), output);
    workspaceMerkleState = undefined;
    workspaceMerkleGeneration = 0;
    layerAvailability = createLayerAvailability();
    resetLayerBenchmarkEvents();
    coordinator.markStale();
    beginBuildGate(() => coordinator.rebuild());
  };

  const waitForCurrentBuild = async (): Promise<boolean> => {
    if (initialSnapshotRestorePending) {
      await initialSnapshotPromise;
    }

    while (initialFileIndexBuildPending) {
      const token = initialBuildToken;
      await initialIndexPromise;
      if (token === initialBuildToken) {
        break;
      }
    }

    return getConfig().enabled;
  };

  const waitForInitialSnapshotRestore = async (): Promise<void> => {
    if (initialSnapshotRestorePending) {
      await initialSnapshotPromise;
    }
  };

  const isSymbolHydrationComplete = (): boolean => {
    const counts = symbolHydrationScheduler?.getStatusCounts();
    return !counts || (counts.queued === 0 && counts.running === 0);
  };

  const waitForLayer = async (layer: IndexLayer): Promise<boolean> => {
    await waitForInitialSnapshotRestore();

    if (hasLayer(layerAvailability, layer)) {
      return getConfig().enabled;
    }

    while (initialFileIndexBuildPending && !hasLayer(layerAvailability, layer)) {
      await new Promise<void>((resolve) => {
        const existing = layerWaiters.get(layer) ?? [];
        existing.push(resolve);
        layerWaiters.set(layer, existing);
        if (hasLayer(layerAvailability, layer) || !initialFileIndexBuildPending) {
          resolve();
        }
      });

      if (hasLayer(layerAvailability, layer) || !initialFileIndexBuildPending) {
        break;
      }
    }

    return getConfig().enabled && hasLayer(layerAvailability, layer);
  };

  const showLayerWarmingMessage = (layer: IndexLayer): void => {
    const message = layer === 'file'
      ? INITIAL_FILE_LAYER_WARMING_MESSAGE
      : layer === 'text'
        ? INITIAL_TEXT_LAYER_WARMING_MESSAGE
        : layer === 'symbol'
          ? INITIAL_SYMBOL_LAYER_WARMING_MESSAGE
          : INITIAL_INDEXES_WARMING_MESSAGE;
    void vscode.window.showInformationMessage(message);
  };

  if (config.enabled) {
    startInitialBuild();
  }

  if (!config.enabled) {
    coordinator.markStale();
    output.appendLine('Background indexing disabled by configuration.');
  }

  output.appendLine(`fastIndexer enabled=${config.enabled}`);
  const cycleLog = (message: string): void => {
    output.appendLine(`[cycle] ${message}`);
  };
  const cycleSearchMode = createCycleSearchModeCommand(fileIndex, textIndex, symbolIndex, getConfig, cycleLog, semanticIndex);

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.cycleSearchMode', async () => {
    cycleLog('command invoked');
    if (!getConfig().enabled) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    await waitForInitialSnapshotRestore();

    if (initialFileIndexBuildPending && !hasLayer(layerAvailability, 'symbol')) {
      showLayerWarmingMessage('symbol');
    }

    if (!await waitForLayer('symbol')) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    await cycleSearchMode.execute();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.goToFile', async () => {
    cycleSearchMode.reset();
    if (!getConfig().enabled) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    await waitForInitialSnapshotRestore();

    if (initialFileIndexBuildPending && !hasLayer(layerAvailability, 'file')) {
      showLayerWarmingMessage('file');
    }

    if (!await waitForLayer('file')) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    await goToFile(fileIndex, getConfig());
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.goToText', async () => {
    cycleSearchMode.reset();
    if (!getConfig().enabled) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    await waitForInitialSnapshotRestore();

    if (initialFileIndexBuildPending && !hasLayer(layerAvailability, 'text')) {
      showLayerWarmingMessage('text');
    }

    if (!await waitForLayer('text')) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    await goToText(textIndex, getConfig());
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.goToSymbol', async () => {
    cycleSearchMode.reset();
    if (!getConfig().enabled) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    await waitForInitialSnapshotRestore();

    if (initialFileIndexBuildPending && !hasLayer(layerAvailability, 'symbol')) {
      showLayerWarmingMessage('symbol');
    }

    if (!await waitForLayer('symbol')) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    await goToSymbol(symbolIndex, getConfig(), {}, {
      partialResultsMessage: isSymbolHydrationComplete() ? undefined : PARTIAL_SYMBOL_INDEX_MESSAGE
    }, semanticIndex);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.rebuildIndex', async () => {
    if (!getConfig().enabled) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    if (initialFileIndexBuildPending) {
      void vscode.window.showInformationMessage(INITIAL_INDEX_REBUILD_BLOCKED_MESSAGE);
      return;
    }

    await rebuildIndex(coordinator);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.findUsages', async () => {
    const currentConfig = getConfig();
    if (!currentConfig.enabled) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    const allowFallback = currentConfig.enabled && currentConfig.providerFallback;
    await findUsages(textIndex, symbolIndex, {
      allowTextFallback: allowFallback,
      allowSymbolFallback: allowFallback && currentConfig.symbolFallback,
      completionStyleResults: currentConfig.completionStyleResults,
      fuzzySearch: currentConfig.fuzzySearch,
      useFzf: currentConfig.useFzf,
      awaitFallbackReady: allowFallback
          ? async () => {
            if (initialFileIndexBuildPending && !hasLayer(layerAvailability, 'text')) {
              showLayerWarmingMessage('text');
            }

            if (!await waitForLayer('text')) {
              void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
              return false;
            }

            return true;
          }
        : undefined
    });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.findImplementations', async () => {
    const currentConfig = getConfig();
    if (!currentConfig.enabled) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    const allowSymbolFallback = currentConfig.enabled && currentConfig.providerFallback && currentConfig.symbolFallback;
    await findImplementations(symbolIndex, {
      allowSymbolFallback,
      completionStyleResults: currentConfig.completionStyleResults,
      fuzzySearch: currentConfig.fuzzySearch,
      useFzf: currentConfig.useFzf,
      awaitFallbackReady: allowSymbolFallback
          ? async () => {
            if (initialFileIndexBuildPending && !hasLayer(layerAvailability, 'symbol')) {
              showLayerWarmingMessage('symbol');
            }

            if (!await waitForLayer('symbol')) {
              void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
              return false;
            }

            return true;
          }
        : undefined
    });
  }));

  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate((uri) => {
      queueWorkspaceRefreshForJob({
        type: 'create',
        relativePath: vscode.workspace.asRelativePath(uri, false),
        filePath: uri.fsPath
      });
    }),
    watcher.onDidChange((uri) => {
      queueWorkspaceRefreshForJob({
        type: 'change',
        relativePath: vscode.workspace.asRelativePath(uri, false),
        filePath: uri.fsPath
      });
    }),
    watcher.onDidDelete((uri) => {
      queueWorkspaceRefreshForJob({
        type: 'delete',
        relativePath: vscode.workspace.asRelativePath(uri, false),
        filePath: uri.fsPath
      });
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('fastIndexer.enabled')) {
        if (!getConfig().enabled) {
          if (rebuildTimeout) {
            clearTimeout(rebuildTimeout);
            rebuildTimeout = undefined;
          }

          initialBuildToken += 1;
          semanticService.cancelGeneration(buildGeneration);
          buildGeneration += 1;
          symbolHydrationScheduler?.cancel();
          semanticService.clear();
          rebuildQueued = false;
          rebuildInFlight = false;
          pendingUpdateJobs = [];
          fileIndex.clear();
          symbolIndex.clear();
          textIndex.clear();
          semanticIndex.clear();
          workspaceMerkleState = undefined;
          workspaceMerkleGeneration = 0;
          clearActiveBuildMerkleState();
          resetLayerBenchmarkEvents();
          coordinator.markStale();
          initialFileIndexBuildPending = false;
          resolveAllLayerWaiters();
          output.appendLine('Background indexing disabled by configuration.');
          return;
        }

        startInitialBuild();
        return;
      }

      if (requiresRebuild(event) && getConfig().enabled) {
        startConfigRebuild();
      }
    })
  );

  context.subscriptions.push(
    buildStatusItem,
    output,
    {
      dispose: () => {
        symbolHydrationScheduler?.cancel();
        semanticService.cancelGeneration(buildGeneration);
        semanticService.clear();
      }
    }
  );

  function createWorkspaceSymbolHydrationScheduler(): SymbolHydrationScheduler {
    return new SymbolHydrationScheduler({
      concurrency: SYMBOL_PHASE_CONCURRENCY,
      batchSize: SYMBOL_HYDRATION_BATCH_SIZE,
      getGeneration: () => buildGeneration,
      isCurrent: (item, generation) => isCurrentSymbolHydrationItem(item, generation),
      worker: async (item, generation): Promise<SymbolHydrationWorkerResult> => {
        const relativePath = normalizeWorkspaceMerklePath(item.relativePath);
        const result = await refreshWorkspaceSymbolsOnly(
          item.uri,
          relativePath,
          getConfig(),
          generation,
          output,
          () => isCurrentSymbolHydrationItem(item, generation),
          semanticService,
          symbolIndex,
          semanticIndex
        );

        if (result.aborted) {
          return { status: 'skipped' };
        }
        if (result.symbolTimedOut) {
          return { status: 'timedOut' };
        }
        if (result.failed) {
          return { status: 'failed' };
        }

        return { status: 'hydrated' };
      },
      onBatchComplete: async (counts) => {
        recordBenchmarkEvent('symbolBatch', counts.hydrated);
        const expectedMerkle = workspaceMerkleState;
        const expectedGeneration = workspaceMerkleGeneration;
        if (expectedMerkle && expectedGeneration === buildGeneration) {
          await persistLayerCheckpoint(expectedMerkle, undefined, () =>
            getConfig().enabled
            && workspaceMerkleGeneration === expectedGeneration
            && buildGeneration === expectedGeneration
            && workspaceMerkleState === expectedMerkle
          );
        }
      }
    });
  }

  function isCurrentSymbolHydrationItem(item: SymbolHydrationPlanItem, generation: number): boolean {
    if (!getConfig().enabled || generation !== buildGeneration) {
      return false;
    }

    const leaf = workspaceMerkleGeneration === generation
      ? workspaceMerkleState?.leavesByPath.get(normalizeWorkspaceMerklePath(item.relativePath))
      : undefined;
    return !leaf || leaf.contentHash === item.contentHash;
  }
}

function normalizeWorkspaceMerklePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

function isMissingFileError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'FileNotFound';
}

function isPersistedMerkleSnapshot(snapshot: PersistedWorkspaceSnapshot['merkle'] | undefined): snapshot is PersistedMerkleSnapshot {
  return !!snapshot
    && typeof snapshot.rootHash === 'string'
    && Array.isArray(snapshot.subtreeHashes)
    && snapshot.subtreeHashes.every((entry) => entry && typeof entry.path === 'string' && typeof entry.hash === 'string')
    && Array.isArray(snapshot.leaves)
    && snapshot.leaves.every((leaf) =>
      leaf
      && typeof leaf.relativePath === 'string'
      && typeof leaf.uri === 'string'
      && typeof leaf.contentHash === 'string'
      && typeof leaf.size === 'number'
    );
}

function createWorkspaceMerkleLeafMap(leaves: WorkspaceMerkleEntry[]): Map<string, WorkspaceMerkleEntry> {
  return new Map(leaves.map((leaf) => [normalizeWorkspaceMerklePath(leaf.relativePath), leaf] as const));
}

async function readWorkspaceMerkleEntry(
  file: vscode.Uri,
  relativePath: string,
  config: FastIndexerConfig
): Promise<WorkspaceMerkleEntry> {
  const bytes = await vscode.workspace.fs.readFile(file);
  const size = bytes.byteLength;
  const entry: WorkspaceMerkleEntry = {
    relativePath,
    uri: file.toString(),
    contentHash: hashContent(Buffer.from(bytes)),
    size
  };
  if (isEligibleTextFile(relativePath, size, config.maxFileSizeKb)) {
    entry.textContent = Buffer.from(bytes).toString('utf8');
  }
  return entry;
}

function createPersistedMerkleLeafMap(leaves: PersistedWorkspaceSnapshot['merkle']['leaves']): Map<string, PersistedWorkspaceSnapshot['merkle']['leaves'][number]> {
  return new Map(leaves.map((leaf) => [normalizeWorkspaceMerklePath(leaf.relativePath), leaf] as const));
}

function removeWorkspaceFileEntries(
  relativePath: string,
  fileIndex: FileIndex,
  symbolIndex: SymbolIndex,
  textIndex: TextIndex,
  semanticIndex: SemanticIndex
): void {
  fileIndex.removeForFile(relativePath);
  symbolIndex.removeForFile(relativePath);
  textIndex.removeForFile(relativePath);
  semanticIndex.removeForFile(relativePath);
}

async function reindexWorkspaceFile(
  file: vscode.Uri,
  relativePath: string,
  config: FastIndexerConfig,
  generation: number,
  output: vscode.OutputChannel,
  shouldContinue: () => boolean,
  semanticService: SemanticEnrichmentService,
  fileIndex: FileIndex,
  symbolIndex: SymbolIndex,
  textIndex: TextIndex,
  semanticIndex: SemanticIndex,
  textContent?: string
): Promise<{ aborted: boolean; symbolTimedOut: boolean; textReadFailed: boolean; }> {
  removeWorkspaceFileEntries(relativePath, fileIndex, symbolIndex, textIndex, semanticIndex);
  fileIndex.upsert(relativePath, file.toString(), toIndexedFileKey(file, relativePath));

  let symbolTimedOut = false;
  try {
    const symbolResult = await getDocumentSymbolsForBuild(file, config.symbolProviderTimeoutMs);
    if (!shouldContinue()) {
      return { aborted: true, symbolTimedOut, textReadFailed: false };
    }

    if (symbolResult.timedOut) {
      symbolTimedOut = true;
      output.appendLine(
        `Timed out reading document symbols for ${relativePath} after ${config.symbolProviderTimeoutMs}ms; continuing without symbol results.`
      );
    } else {
      symbolIndex.replaceForFile(relativePath, symbolResult.symbols);
      semanticService.enqueueFile(relativePath, symbolResult.symbols, generation);
    }
  } catch (error) {
    output.appendLine(`Failed to read ${relativePath} for symbol indexing: ${error instanceof Error ? error.message : String(error)}`);
  }

  let textReadFailed = false;
  try {
    const content = textContent !== undefined
      ? textContent
      : await readEligibleTextContent(vscode.workspace.fs, file, relativePath, config.maxFileSizeKb);
    if (!shouldContinue()) {
      return { aborted: true, symbolTimedOut, textReadFailed };
    }

    if (content !== undefined) {
      textIndex.upsert(relativePath, file.toString(), content);
    }
  } catch (error) {
    textReadFailed = true;
    output.appendLine(`Failed to read ${relativePath} for text indexing: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { aborted: false, symbolTimedOut, textReadFailed };
}

async function refreshWorkspaceSymbolsOnly(
  file: vscode.Uri,
  relativePath: string,
  config: FastIndexerConfig,
  generation: number,
  output: vscode.OutputChannel,
  shouldContinue: () => boolean,
  semanticService: SemanticEnrichmentService,
  symbolIndex: SymbolIndex,
  semanticIndex: SemanticIndex
): Promise<{ aborted: boolean; symbolTimedOut: boolean; failed: boolean; }> {
  if (!shouldContinue()) {
    return { aborted: true, symbolTimedOut: false, failed: false };
  }

  symbolIndex.removeForFile(relativePath);
  semanticIndex.removeForFile(relativePath);

  let symbolTimedOut = false;
  try {
    const symbolResult = await getDocumentSymbolsForBuild(file, config.symbolProviderTimeoutMs);
    if (!shouldContinue()) {
      return { aborted: true, symbolTimedOut, failed: false };
    }

    if (symbolResult.timedOut) {
      symbolTimedOut = true;
      output.appendLine(
        `Timed out reading document symbols for ${relativePath} after ${config.symbolProviderTimeoutMs}ms; continuing without symbol results.`
      );
    } else {
      symbolIndex.replaceForFile(relativePath, symbolResult.symbols);
      semanticService.enqueueFile(relativePath, symbolResult.symbols, generation);
    }
  } catch (error) {
    output.appendLine(`Failed to read ${relativePath} for symbol indexing: ${error instanceof Error ? error.message : String(error)}`);
    return { aborted: false, symbolTimedOut, failed: true };
  }

  return { aborted: false, symbolTimedOut, failed: false };
}

async function buildCurrentWorkspaceMerkle(
  files: vscode.Uri[],
  config: FastIndexerConfig,
  ignoreMatcher: IgnoreMatcher,
  output: vscode.OutputChannel,
  shouldContinue: () => boolean,
  buildStatus: IndexBuildStatusReporter,
  progressToken: number
): Promise<{ tree: MerkleTreeSnapshot; leavesByPath: Map<string, WorkspaceMerkleEntry>; } | undefined> {
  const leaves: WorkspaceMerkleEntry[] = [];
  let processedFiles = 0;
  let skippedFiles = 0;
  let symbolTimeouts = 0;

  buildStatus.setTotalFiles(progressToken, files.length);
  for (const file of files) {
    if (!shouldContinue()) {
      return undefined;
    }

    const relativePath = normalizeWorkspaceMerklePath(vscode.workspace.asRelativePath(file, true));
    if (ignoreMatcher.ignores(file.fsPath, relativePath)) {
      processedFiles += 1;
      skippedFiles += 1;
      buildStatus.advance(progressToken, {
        processedFiles,
        skippedFiles,
        symbolTimeouts,
        currentFile: relativePath
      });
      if (shouldYield(INDEX_BUILD_YIELD_INTERVAL, processedFiles)) {
        await yieldToEventLoop();
      }
      continue;
    }

    try {
      leaves.push(await readWorkspaceMerkleEntry(file, relativePath, config));
    } catch (error) {
      output.appendLine(`Failed to read ${relativePath} for Merkle indexing: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }

    processedFiles += 1;
    buildStatus.advance(progressToken, {
      processedFiles,
      skippedFiles,
      symbolTimeouts,
      currentFile: relativePath
    });
    if (shouldYield(INDEX_BUILD_YIELD_INTERVAL, processedFiles)) {
      await yieldToEventLoop();
    }
  }

  try {
    const tree = buildMerkleTree(leaves);
    return {
      tree,
      leavesByPath: createWorkspaceMerkleLeafMap(leaves)
    };
  } catch (error) {
    output.appendLine(`Failed to build workspace Merkle tree: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function buildWorkspaceIndexesFull(
  files: vscode.Uri[],
  fileIndex: FileIndex,
  symbolIndex: SymbolIndex,
  textIndex: TextIndex,
  semanticService: SemanticEnrichmentService,
  generation: number,
  config: FastIndexerConfig,
  ignoreMatcher: IgnoreMatcher,
  output: vscode.OutputChannel,
  shouldContinue: () => boolean,
  buildStatus: IndexBuildStatusReporter,
  progressToken: number,
  semanticIndex: SemanticIndex,
  clearExistingEntries = false
): Promise<BuildWorkspaceIndexesResult> {
  if (clearExistingEntries) {
    fileIndex.clear();
    symbolIndex.clear();
    textIndex.clear();
    semanticIndex.clear();
  }

  const merkleLeaves: WorkspaceMerkleEntry[] = [];
  let processedFiles = 0;
  let skippedFiles = 0;
  let symbolTimeouts = 0;

  buildStatus.setTotalFiles(progressToken, files.length);
  for (const file of files) {
    if (!shouldContinue()) {
      return { completed: false, canPersistSnapshot: false };
    }

    const relativePath = normalizeWorkspaceMerklePath(vscode.workspace.asRelativePath(file, true));
    if (ignoreMatcher.ignores(file.fsPath, relativePath)) {
      processedFiles += 1;
      skippedFiles += 1;
      buildStatus.advance(progressToken, {
        processedFiles,
        skippedFiles,
        symbolTimeouts,
        currentFile: relativePath
      });
      if (shouldYield(INDEX_BUILD_YIELD_INTERVAL, processedFiles)) {
        await yieldToEventLoop();
      }
      continue;
    }

    let merkleEntry: WorkspaceMerkleEntry | undefined;
    try {
      merkleEntry = await readWorkspaceMerkleEntry(file, relativePath, config);
    } catch (error) {
      output.appendLine(`Failed to read ${relativePath} for Merkle indexing: ${error instanceof Error ? error.message : String(error)}`);
      try {
        merkleEntry = await readWorkspaceMerkleEntry(file, relativePath, config);
      } catch (retryError) {
        skippedFiles += 1;
        processedFiles += 1;
        output.appendLine(`Skipping ${relativePath} because Merkle indexing could not read the file: ${retryError instanceof Error ? retryError.message : String(retryError)}`);
        buildStatus.advance(progressToken, {
          processedFiles,
          skippedFiles,
          symbolTimeouts,
          currentFile: relativePath
        });
        if (shouldYield(INDEX_BUILD_YIELD_INTERVAL, processedFiles)) {
          await yieldToEventLoop();
        }
        continue;
      }
    }

    merkleLeaves.push(merkleEntry);

    const result = await reindexWorkspaceFile(
      file,
      relativePath,
      config,
      generation,
      output,
      shouldContinue,
      semanticService,
      fileIndex,
      symbolIndex,
      textIndex,
      semanticIndex,
      merkleEntry.textContent
    );

    if (result.aborted) {
      return { completed: false, canPersistSnapshot: false };
    }

    if (result.symbolTimedOut) {
      symbolTimeouts += 1;
    }

    processedFiles += 1;
    buildStatus.advance(progressToken, {
      processedFiles,
      skippedFiles,
      symbolTimeouts,
      currentFile: relativePath
    });
    if (shouldYield(INDEX_BUILD_YIELD_INTERVAL, processedFiles)) {
      await yieldToEventLoop();
    }
  }

  try {
    return {
      completed: true,
      canPersistSnapshot: true,
      merkle: buildMerkleTree(merkleLeaves)
    };
  } catch (error) {
    output.appendLine(`Failed to build workspace Merkle tree: ${error instanceof Error ? error.message : String(error)}`);
    return { completed: true, canPersistSnapshot: false };
  }
}

async function reconcileWorkspaceIndexesFromMerkle(
  currentMerkle: { tree: MerkleTreeSnapshot; leavesByPath: Map<string, WorkspaceMerkleEntry>; },
  previousSnapshot: PersistedWorkspaceSnapshot,
  fileIndex: FileIndex,
  symbolIndex: SymbolIndex,
  textIndex: TextIndex,
  semanticService: SemanticEnrichmentService,
  semanticIndex: SemanticIndex,
  generation: number,
  config: FastIndexerConfig,
  output: vscode.OutputChannel,
  shouldContinue: () => boolean,
  buildStatus: IndexBuildStatusReporter,
  progressToken: number
): Promise<BuildWorkspaceIndexesResult> {
  const previousMerkleLeaves = createPersistedMerkleLeafMap(previousSnapshot.merkle.leaves);
  const previousSymbolEntries = new Map(
    previousSnapshot.symbolIndex.map((entry) => [normalizeWorkspaceMerklePath(entry.relativePath), entry] as const)
  );
  const diff = diffMerkleLeaves(previousMerkleLeaves as Map<string, MerkleLeafRecord>, currentMerkle.leavesByPath);
  const symbolOnlyLeaves = diff.unchanged.filter((leaf) => {
    const previousSymbolEntry = previousSymbolEntries.get(leaf.relativePath);
    return !previousSymbolEntry?.contentHash || previousSymbolEntry.contentHash !== leaf.contentHash;
  });
  const totalWork = diff.removed.length + diff.changed.length + diff.added.length + symbolOnlyLeaves.length;
  let processedFiles = 0;
  let skippedFiles = 0;
  let symbolTimeouts = 0;

  buildStatus.setTotalFiles(progressToken, totalWork);

  for (const leaf of diff.removed) {
    if (!shouldContinue()) {
      return { completed: false, canPersistSnapshot: false };
    }

    removeWorkspaceFileEntries(leaf.relativePath, fileIndex, symbolIndex, textIndex, semanticIndex);
    processedFiles += 1;
    buildStatus.advance(progressToken, {
      processedFiles,
      skippedFiles,
      symbolTimeouts,
      currentFile: leaf.relativePath
    });
  }

  for (const leaf of [...diff.changed, ...diff.added]) {
    if (!shouldContinue()) {
      return { completed: false, canPersistSnapshot: false };
    }

    const file = vscode.Uri.parse(leaf.uri);
    const currentLeaf = currentMerkle.leavesByPath.get(leaf.relativePath);
    if (!currentLeaf) {
      return { completed: false, canPersistSnapshot: false };
    }

    const result = await reindexWorkspaceFile(
      file,
      currentLeaf.relativePath,
      config,
      generation,
      output,
      shouldContinue,
      semanticService,
      fileIndex,
      symbolIndex,
      textIndex,
      semanticIndex,
      currentLeaf.textContent
    );

    if (result.aborted) {
      return { completed: false, canPersistSnapshot: false };
    }

    if (result.symbolTimedOut) {
      symbolTimeouts += 1;
    }

    processedFiles += 1;
    buildStatus.advance(progressToken, {
      processedFiles,
      skippedFiles,
      symbolTimeouts,
      currentFile: leaf.relativePath
    });
  }

  for (const leaf of symbolOnlyLeaves) {
    if (!shouldContinue()) {
      return { completed: false, canPersistSnapshot: false };
    }

    const file = vscode.Uri.parse(leaf.uri);
    const result = await refreshWorkspaceSymbolsOnly(
      file,
      leaf.relativePath,
      config,
      generation,
      output,
      shouldContinue,
      semanticService,
      symbolIndex,
      semanticIndex
    );

    if (result.aborted) {
      return { completed: false, canPersistSnapshot: false };
    }

    if (result.symbolTimedOut) {
      symbolTimeouts += 1;
    }

    processedFiles += 1;
    buildStatus.advance(progressToken, {
      processedFiles,
      skippedFiles,
      symbolTimeouts,
      currentFile: leaf.relativePath
    });
  }

  return {
    completed: true,
    canPersistSnapshot: true,
    merkle: currentMerkle.tree
  };
}

async function buildWorkspaceIndexes(
  fileIndex: FileIndex,
  symbolIndex: SymbolIndex,
  textIndex: TextIndex,
  semanticService: SemanticEnrichmentService,
  semanticIndex: SemanticIndex,
  generation: number,
  config: FastIndexerConfig,
  ignoreMatcher: IgnoreMatcher,
  output: vscode.OutputChannel,
  shouldContinue: () => boolean,
  buildStatus: IndexBuildStatusReporter,
  progressToken: number,
  previousSnapshot?: PersistedWorkspaceSnapshot
): Promise<BuildWorkspaceIndexesResult> {
  try {
    if (config.include.length === 0) {
      return { completed: true, canPersistSnapshot: false };
    }

    const files = await vscode.workspace.findFiles(
      toGlobExpression(config.include, '**/*'),
      toGlobExpression([WORKSPACE_FILE_EXCLUDE_GLOB, ...config.exclude], WORKSPACE_FILE_EXCLUDE_GLOB)
    );

    const safePreviousMerkle = isPersistedMerkleSnapshot(previousSnapshot?.merkle) ? previousSnapshot.merkle : undefined;
    if (safePreviousMerkle) {
      const currentMerkle = await buildCurrentWorkspaceMerkle(files, config, ignoreMatcher, output, shouldContinue, buildStatus, progressToken);
      if (!currentMerkle) {
        return await buildWorkspaceIndexesFull(
          files,
          fileIndex,
          symbolIndex,
          textIndex,
          semanticService,
          generation,
          config,
          ignoreMatcher,
          output,
          shouldContinue,
          buildStatus,
          progressToken,
          semanticIndex,
          true
        );
      }

      return await reconcileWorkspaceIndexesFromMerkle(
        currentMerkle,
        previousSnapshot!,
        fileIndex,
        symbolIndex,
        textIndex,
        semanticService,
        semanticIndex,
        generation,
        config,
        output,
        shouldContinue,
        buildStatus,
        progressToken
      );
    }

    return await buildWorkspaceIndexesFull(
      files,
      fileIndex,
      symbolIndex,
      textIndex,
      semanticService,
      generation,
      config,
      ignoreMatcher,
      output,
      shouldContinue,
      buildStatus,
      progressToken,
      semanticIndex
    );
  } catch (error) {
    output.appendLine(`Failed to build initial file index: ${error instanceof Error ? error.message : String(error)}`);
    return { completed: false, canPersistSnapshot: false };
  }
}

function pruneRestoredWorkspaceEntries(
  fileIndex: FileIndex,
  symbolIndex: SymbolIndex,
  textIndex: TextIndex,
  semanticIndex: SemanticIndex,
  candidates: WorkspaceCandidate[]
): void {
  const currentRelativePaths = new Set(candidates.map((candidate) => normalizeWorkspaceMerklePath(candidate.relativePath)));
  const currentFileKeys = new Set(candidates.map((candidate) => toIndexedFileKey(candidate.uri, candidate.relativePath)));

  for (const entry of fileIndex.all()) {
    const key = toIndexedSnapshotKey(entry);
    if (!currentFileKeys.has(key)) {
      fileIndex.removeForFile(entry.relativePath, key);
    }
  }

  for (const entry of textIndex.allContents()) {
    if (!currentRelativePaths.has(normalizeWorkspaceMerklePath(entry.relativePath))) {
      textIndex.removeForFile(entry.relativePath);
    }
  }

  for (const entry of symbolIndex.allByFile()) {
    if (!currentRelativePaths.has(normalizeWorkspaceMerklePath(entry.relativePath))) {
      symbolIndex.removeForFile(entry.relativePath);
    }
  }

  for (const entry of semanticIndex.allByFile()) {
    if (!currentRelativePaths.has(normalizeWorkspaceMerklePath(entry.relativePath))) {
      semanticIndex.removeForFile(entry.relativePath);
    }
  }
}

function canReuseSnapshotLayer(snapshot: PersistedWorkspaceSnapshot | undefined, layer: IndexLayer): boolean {
  return snapshot?.metadata.layerState?.availableLayers.includes(layer) ?? snapshot !== undefined;
}

function createReuseHintsFromSnapshot(
  previousSnapshot: PersistedWorkspaceSnapshot | undefined,
  currentMerkle: { tree: MerkleTreeSnapshot; leavesByPath: Map<string, WorkspaceMerkleEntry>; }
): {
  file: Set<string>;
  text: Set<string>;
  symbol: Set<string>;
} {
  const reuseHints = {
    file: new Set<string>(),
    text: new Set<string>(),
    symbol: new Set<string>()
  };

  const previousMerkle = isPersistedMerkleSnapshot(previousSnapshot?.merkle) ? previousSnapshot.merkle : undefined;
  if (!previousSnapshot || !previousMerkle) {
    return reuseHints;
  }

  const previousLeaves = createPersistedMerkleLeafMap(previousMerkle.leaves) as Map<string, MerkleLeafRecord>;
  const previousTextEntries = new Map(
    previousSnapshot.textIndex.map((entry) => [normalizeWorkspaceMerklePath(entry.relativePath), entry] as const)
  );
  const previousSymbolEntries = new Map(
    previousSnapshot.symbolIndex.map((entry) => [normalizeWorkspaceMerklePath(entry.relativePath), entry] as const)
  );
  const diff = diffMerkleLeaves(previousLeaves, currentMerkle.leavesByPath);

  for (const leaf of diff.unchanged) {
    if (canReuseSnapshotLayer(previousSnapshot, 'file')) {
      reuseHints.file.add(leaf.relativePath);
    }

    if (canReuseSnapshotLayer(previousSnapshot, 'text')) {
      const previousTextEntry = previousTextEntries.get(leaf.relativePath);
      if (previousTextEntry?.contentHash === leaf.contentHash) {
        reuseHints.text.add(leaf.relativePath);
      }
    }

    if (canReuseSnapshotLayer(previousSnapshot, 'symbol')) {
      const previousSymbolEntry = previousSymbolEntries.get(leaf.relativePath);
      if (previousSymbolEntry?.contentHash && previousSymbolEntry.contentHash === leaf.contentHash) {
        reuseHints.symbol.add(leaf.relativePath);
      }
    }
  }

  return reuseHints;
}

async function buildCurrentWorkspaceMerkleFromCandidates(
  candidates: WorkspaceCandidate[],
  config: FastIndexerConfig,
  output: vscode.OutputChannel,
  shouldContinue: () => boolean,
  buildStatus: IndexBuildStatusReporter,
  progressToken: number,
  skippedFiles: number,
  onLeafRead?: (candidate: WorkspaceCandidate, leaf: WorkspaceMerkleEntry) => void,
  onReadFailed?: () => void
): Promise<{ tree: MerkleTreeSnapshot; leavesByPath: Map<string, WorkspaceMerkleEntry>; } | undefined> {
  const leaves: WorkspaceMerkleEntry[] = [];
  let processedFiles = skippedFiles;
  const symbolTimeouts = 0;
  let stop = false;
  let readFailed = false;

  buildStatus.advance(progressToken, {
    processedFiles,
    skippedFiles,
    symbolTimeouts,
    currentFile: undefined,
    currentLayer: 'text'
  });

  await runPhaseJobs(candidates, TEXT_PHASE_CONCURRENCY, async (candidate) => {
    if (stop || !shouldContinue()) {
      stop = true;
      return;
    }

    try {
      const leaf = await readWorkspaceMerkleEntry(candidate.uri, normalizeWorkspaceMerklePath(candidate.relativePath), config);
      if (!shouldContinue()) {
        stop = true;
        return;
      }
      leaves.push(leaf);
      onLeafRead?.(candidate, leaf);
    } catch (error) {
      output.appendLine(
        `Failed to read ${candidate.relativePath} for Merkle indexing: ${error instanceof Error ? error.message : String(error)}`
      );
      readFailed = true;
      stop = true;
      if (shouldContinue()) {
        onReadFailed?.();
      }
      return;
    }

    processedFiles += 1;
    buildStatus.advance(progressToken, {
      processedFiles,
      skippedFiles,
      symbolTimeouts,
      currentFile: candidate.relativePath,
      currentLayer: 'text'
    });
    if (shouldYield(INDEX_BUILD_YIELD_INTERVAL, processedFiles - skippedFiles)) {
      await yieldToEventLoop();
    }
  });

  if (readFailed || stop || !shouldContinue()) {
    return undefined;
  }

  try {
    const tree = buildMerkleTree(leaves);
    return {
      tree,
      leavesByPath: createWorkspaceMerkleLeafMap(leaves)
    };
  } catch (error) {
    output.appendLine(`Failed to build workspace Merkle tree: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function buildWorkspaceIndexesLayered(
  fileIndex: FileIndex,
  symbolIndex: SymbolIndex,
  textIndex: TextIndex,
  semanticIndex: SemanticIndex,
  semanticService: SemanticEnrichmentService,
  generation: number,
  config: FastIndexerConfig,
  ignoreMatcher: IgnoreMatcher,
  output: vscode.OutputChannel,
  shouldContinue: () => boolean,
  buildStatus: IndexBuildStatusReporter,
  progressToken: number,
  previousSnapshot: PersistedWorkspaceSnapshot | undefined,
  markLayerReady: (layer: IndexLayer) => void,
  invalidateLayers: InvalidateLayers,
  persistCheckpoint: PersistCheckpoint,
  setCurrentBuildMerkle: (merkleSnapshot: MerkleTreeSnapshot, generation: number) => void,
  isCurrentBuildMerkle: (merkleSnapshot: MerkleTreeSnapshot, generation: number) => boolean
): Promise<BuildWorkspaceIndexesResult> {
  try {
    if (config.include.length === 0) {
      markLayerReady('file');
      markLayerReady('text');
      markLayerReady('symbol');
      return {
        completed: true,
        canPersistSnapshot: false,
        pendingSymbolHydration: { items: [], generation }
      };
    }

    const files = await vscode.workspace.findFiles(
      toGlobExpression(config.include, '**/*'),
      toGlobExpression([WORKSPACE_FILE_EXCLUDE_GLOB, ...config.exclude], WORKSPACE_FILE_EXCLUDE_GLOB)
    );
    const candidates = files
      .map((file) => ({
        uri: file,
        relativePath: normalizeWorkspaceMerklePath(vscode.workspace.asRelativePath(file, true))
      }))
      .filter((candidate) => !ignoreMatcher.ignores(candidate.uri.fsPath, candidate.relativePath));
    const sortedCandidates = createIndexBuildPlan(candidates, {
      file: new Set(),
      text: new Set(),
      symbol: new Set()
    }).filePhase;
    const skippedFiles = files.length - sortedCandidates.length;
    const restoredFileLayer = canReuseSnapshotLayer(previousSnapshot, 'file');
    const restoredTextLayer = canReuseSnapshotLayer(previousSnapshot, 'text');
    const earlyTextHydratedPaths = new Set<string>();
    let textLayerMarkedReady = restoredTextLayer;
    let merkleReadFailed = false;
    let readyTextCheckpointAttempted = false;
    let symbolTimeouts = 0;

    const markTextLayerReady = (): boolean => {
      if (textLayerMarkedReady || merkleReadFailed) {
        return false;
      }

      textLayerMarkedReady = true;
      markLayerReady('text');
      return true;
    };

    const hydrateEarlyTextFromMerkleLeaf = (candidate: WorkspaceCandidate, leaf: WorkspaceMerkleEntry): void => {
      if (merkleReadFailed || restoredTextLayer || textLayerMarkedReady || earlyTextHydratedPaths.size >= TEXT_HYDRATION_BATCH_SIZE || !shouldContinue()) {
        return;
      }

      const normalizedPath = normalizeWorkspaceMerklePath(candidate.relativePath);
      if (earlyTextHydratedPaths.has(normalizedPath)) {
        return;
      }

      if (leaf.textContent === undefined) {
        textIndex.removeForFile(candidate.relativePath);
      } else {
        textIndex.upsert(candidate.relativePath, candidate.uri.toString(), leaf.textContent);
      }
      earlyTextHydratedPaths.add(normalizedPath);

      if (earlyTextHydratedPaths.size >= TEXT_HYDRATION_BATCH_SIZE) {
        markTextLayerReady();
      }
    };

    pruneRestoredWorkspaceEntries(fileIndex, symbolIndex, textIndex, semanticIndex, sortedCandidates);
    buildStatus.setTotalFiles(progressToken, files.length);
    if (!restoredFileLayer) {
      buildStatus.advance(progressToken, {
        processedFiles: skippedFiles,
        skippedFiles,
        symbolTimeouts,
        currentFile: undefined,
        currentLayer: 'file'
      });

      let filePhaseProcessed = skippedFiles;
      for (const candidate of sortedCandidates) {
        if (!shouldContinue()) {
          return { completed: false, canPersistSnapshot: false };
        }

        fileIndex.upsert(candidate.relativePath, candidate.uri.toString(), toIndexedFileKey(candidate.uri, candidate.relativePath));
        filePhaseProcessed += 1;
        buildStatus.advance(progressToken, {
          processedFiles: filePhaseProcessed,
          skippedFiles,
          symbolTimeouts,
          currentFile: candidate.relativePath,
          currentLayer: 'file'
        });
        if (shouldYield(INDEX_BUILD_YIELD_INTERVAL, filePhaseProcessed - skippedFiles)) {
          await yieldToEventLoop();
        }
      }

      markLayerReady('file');
    }

    const currentMerkle = await buildCurrentWorkspaceMerkleFromCandidates(
      sortedCandidates,
      config,
      output,
      shouldContinue,
      buildStatus,
      progressToken,
      skippedFiles,
      hydrateEarlyTextFromMerkleLeaf,
      () => {
        merkleReadFailed = true;
        textLayerMarkedReady = false;
        invalidateLayers(['file', 'text', 'symbol']);
      }
    );
    if (!currentMerkle) {
      if (!shouldContinue()) {
        return { completed: false, canPersistSnapshot: false };
      }

      invalidateLayers(['file', 'text', 'symbol']);
      const fallback = await buildWorkspaceIndexesFull(
        sortedCandidates.map((candidate) => candidate.uri),
        fileIndex,
        symbolIndex,
        textIndex,
        semanticService,
        generation,
        config,
        ignoreMatcher,
        output,
        shouldContinue,
        buildStatus,
        progressToken,
        semanticIndex,
        true
      );
      if (fallback.completed) {
        markLayerReady('file');
        markLayerReady('text');
        markLayerReady('symbol');
        fallback.pendingSymbolHydration = { items: [], generation };
      }
      return fallback;
    }

    const expectedGeneration = generation;
    const expectedMerkle = currentMerkle.tree;
    setCurrentBuildMerkle(expectedMerkle, expectedGeneration);
    const shouldPersistCurrentMerkle = () =>
      shouldContinue()
      && isCurrentBuildMerkle(expectedMerkle, expectedGeneration);

    await persistCheckpoint(expectedMerkle, 'text', shouldPersistCurrentMerkle);
    if (textLayerMarkedReady) {
      readyTextCheckpointAttempted = true;
    }

    const reuseHints = createReuseHintsFromSnapshot(previousSnapshot, currentMerkle);
    const plan = createIndexBuildPlan(sortedCandidates, reuseHints);
    if (restoredFileLayer) {
      for (const candidate of plan.filePhase) {
        if (!shouldContinue()) {
          return { completed: false, canPersistSnapshot: false };
        }

        fileIndex.upsert(candidate.relativePath, candidate.uri.toString(), toIndexedFileKey(candidate.uri, candidate.relativePath));
      }
    }
    if (!textLayerMarkedReady && reuseHints.text.size > 0 && plan.textPhase.length === 0) {
      textLayerMarkedReady = true;
    }
    let textPhaseProcessed = skippedFiles + reuseHints.text.size;
    let textBatchProcessed = 0;
    let stopTextPhase = false;

    const tryMarkTextReadyForBatch = (): boolean => {
      if (textLayerMarkedReady || textBatchProcessed < TEXT_HYDRATION_BATCH_SIZE || !shouldContinue()) {
        return false;
      }

      return markTextLayerReady();
    };

    const persistReadyTextCheckpoint = async (): Promise<void> => {
      if (readyTextCheckpointAttempted) {
        return;
      }

      readyTextCheckpointAttempted = true;
      await persistCheckpoint(expectedMerkle, 'text', shouldPersistCurrentMerkle);
    };

    buildStatus.advance(progressToken, {
      processedFiles: textPhaseProcessed,
      skippedFiles,
      symbolTimeouts,
      currentFile: undefined,
      currentLayer: 'text'
    });

    await runPhaseJobs(plan.textPhase, TEXT_PHASE_CONCURRENCY, async (candidate) => {
      if (stopTextPhase || !shouldContinue()) {
        stopTextPhase = true;
        return;
      }

      const normalizedPath = normalizeWorkspaceMerklePath(candidate.relativePath);
      const leaf = currentMerkle.leavesByPath.get(normalizedPath);
      if (!earlyTextHydratedPaths.has(normalizedPath)) {
        if (!leaf || leaf.textContent === undefined) {
          textIndex.removeForFile(candidate.relativePath);
        } else {
          textIndex.upsert(candidate.relativePath, candidate.uri.toString(), leaf.textContent);
        }
      }

      textPhaseProcessed += 1;
      textBatchProcessed += 1;
      buildStatus.advance(progressToken, {
        processedFiles: textPhaseProcessed,
        skippedFiles,
        symbolTimeouts,
        currentFile: candidate.relativePath,
        currentLayer: 'text'
      });
      if (tryMarkTextReadyForBatch()) {
        await persistReadyTextCheckpoint();
      }
      if (shouldYield(INDEX_BUILD_YIELD_INTERVAL, textPhaseProcessed - skippedFiles)) {
        await yieldToEventLoop();
      }
    });

    if (stopTextPhase || !shouldContinue()) {
      return { completed: false, canPersistSnapshot: false };
    }

    if (!textLayerMarkedReady) {
      markTextLayerReady();
    }
    for (const candidate of plan.symbolPhase) {
      symbolIndex.removeForFile(candidate.relativePath);
      semanticIndex.removeForFile(candidate.relativePath);
    }
    await persistCheckpoint(currentMerkle.tree, 'symbol');

    buildStatus.advance(progressToken, {
      processedFiles: files.length,
      skippedFiles,
      symbolTimeouts,
      currentFile: undefined,
      currentLayer: 'symbol'
    });

    const symbolHydrationCandidates = [];
    for (const candidate of plan.symbolPhase) {
      const leaf = currentMerkle.leavesByPath.get(normalizeWorkspaceMerklePath(candidate.relativePath));
      if (!leaf) {
        continue;
      }

      symbolHydrationCandidates.push({
        uri: candidate.uri,
        relativePath: candidate.relativePath,
        contentHash: leaf.contentHash
      });
    }

    if (!shouldContinue()) {
      return { completed: false, canPersistSnapshot: false };
    }

    const openPaths = new Set(
      vscode.window.visibleTextEditors.map((editor) => normalizeWorkspaceMerklePath(vscode.workspace.asRelativePath(editor.document.uri, true)))
    );
    const changedPaths = new Set(
      [...plan.filePhase, ...plan.textPhase].map((candidate) => normalizeWorkspaceMerklePath(candidate.relativePath))
    );
    const symbolHydrationPlan = createSymbolHydrationPlan(symbolHydrationCandidates, {
      openPaths,
      changedPaths,
      hydratedPaths: reuseHints.symbol
    });
    markLayerReady('symbol');
    return {
      completed: true,
      canPersistSnapshot: true,
      merkle: currentMerkle.tree,
      pendingSymbolHydration: {
        items: symbolHydrationPlan.items,
        generation
      }
    };
  } catch (error) {
    output.appendLine(`Failed to build initial file index: ${error instanceof Error ? error.message : String(error)}`);
    return { completed: false, canPersistSnapshot: false };
  }
}

export async function readEligibleTextContent(
  fileSystem: Pick<typeof vscode.workspace.fs, 'stat' | 'readFile'>,
  file: vscode.Uri,
  relativePath: string,
  maxFileSizeKb: number
): Promise<string | undefined> {
  const stat = await fileSystem.stat(file);
  if (!isEligibleTextFile(relativePath, stat.size, maxFileSizeKb)) {
    return undefined;
  }

  const bytes = await fileSystem.readFile(file);
  return Buffer.from(bytes).toString('utf8');
}

async function restorePersistedSnapshot(
  persistenceStore: PersistenceStore,
  workspacePersistence: WorkspacePersistence,
  refreshIgnoreMatcher: () => Promise<IgnoreMatcher>,
  getPersistenceConfigHash: () => string,
  fileIndex: FileIndex,
  symbolIndex: SymbolIndex,
  textIndex: TextIndex,
  semanticIndex: SemanticIndex
): Promise<PersistedWorkspaceSnapshot | undefined> {
  try {
    await refreshIgnoreMatcher();
    const snapshot = await persistenceStore.readWorkspaceSnapshot(workspacePersistence.workspaceId);
    if (!snapshot) {
      return undefined;
    }

    if (!isPersistedSnapshotValid(snapshot, workspacePersistence, getPersistenceConfigHash())) {
      await persistenceStore.clearWorkspaceCache(workspacePersistence.workspaceId);
      return undefined;
    }

    hydrateIndexesFromSnapshot(snapshot, fileIndex, symbolIndex, textIndex, semanticIndex);
    return snapshot;
  } catch (error) {
    await persistenceStore.clearWorkspaceCache(workspacePersistence.workspaceId);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
}

function hydrateIndexesFromSnapshot(
  snapshot: PersistedWorkspaceSnapshot,
  fileIndex: FileIndex,
  symbolIndex: SymbolIndex,
  textIndex: TextIndex,
  semanticIndex: SemanticIndex
): void {
  fileIndex.clear();
  symbolIndex.clear();
  textIndex.clear();
  semanticIndex.clear();

  snapshot.fileIndex.forEach((entry) => {
    fileIndex.upsert(entry.relativePath, entry.uri, toIndexedSnapshotKey(entry));
  });
  snapshot.textIndex.forEach((entry) => {
    textIndex.upsert(entry.relativePath, entry.uri, entry.content);
  });
  snapshot.symbolIndex.forEach((entry) => {
    symbolIndex.replaceForFile(entry.relativePath, entry.symbols);
  });
  snapshot.semanticIndex?.forEach((entry) => {
    semanticIndex.replaceForFile(entry.relativePath, entry.entries);
  });
}

function createPersistedWorkspaceSnapshot(
  workspacePersistence: WorkspacePersistence,
  persistenceConfigHash: string,
  fileIndex: FileIndex,
  symbolIndex: SymbolIndex,
  textIndex: TextIndex,
  semanticIndex: SemanticIndex,
  merkleSnapshot: MerkleTreeSnapshot,
  layerState?: PersistedWorkspaceSnapshot['metadata']['layerState']
): PersistedWorkspaceSnapshot {
  const persistedMerkleLeaves = [...merkleSnapshot.leavesByPath.values()].map((leaf) => ({
    relativePath: leaf.relativePath,
    uri: leaf.uri,
    contentHash: leaf.contentHash,
    size: leaf.size
  }));
  const merkleTrackedPaths = new Set(persistedMerkleLeaves.map((leaf) => normalizeWorkspaceMerklePath(leaf.relativePath)));
  const contentHashByPath = new Map(persistedMerkleLeaves.map((leaf) => [normalizeWorkspaceMerklePath(leaf.relativePath), leaf.contentHash] as const));
  const persistedTextEntries = textIndex.allContents()
    .filter((entry) => merkleTrackedPaths.has(normalizeWorkspaceMerklePath(entry.relativePath)))
    .map((entry) => ({
      relativePath: entry.relativePath,
      uri: entry.uri,
      content: entry.content,
      contentHash: contentHashByPath.get(normalizeWorkspaceMerklePath(entry.relativePath)) ?? hashContent(entry.content)
    }));
  return {
    metadata: {
      schemaVersion: PERSISTENCE_SCHEMA_VERSION,
      workspaceId: workspacePersistence.workspaceId,
      configHash: persistenceConfigHash,
      ...(layerState ? { layerState } : {})
    },
    fileIndex: fileIndex.all().filter((entry) => merkleTrackedPaths.has(normalizeWorkspaceMerklePath(entry.relativePath))),
    merkle: {
      rootHash: merkleSnapshot.rootHash,
      subtreeHashes: toPersistedSubtreeHashes(merkleSnapshot.subtreeHashes),
      leaves: persistedMerkleLeaves
    },
    textIndex: persistedTextEntries,
    symbolIndex: symbolIndex.allByFile()
      .filter((entry) => merkleTrackedPaths.has(normalizeWorkspaceMerklePath(entry.relativePath)))
      .map((entry) => ({
        relativePath: entry.relativePath,
        contentHash: contentHashByPath.get(normalizeWorkspaceMerklePath(entry.relativePath)) ?? null,
        symbols: entry.symbols
      })),
    semanticIndex: semanticIndex.allByFile()
      .filter((entry) => merkleTrackedPaths.has(normalizeWorkspaceMerklePath(entry.relativePath)))
  };
}

function toIndexedFileKey(file: vscode.Uri, relativePath: string): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(file);
  if (!workspaceFolder) {
    return relativePath;
  }

  return `${workspaceFolder.uri.toString()}::${relativePath}`;
}

function toIndexedSnapshotKey(entry: PersistedWorkspaceSnapshot['fileIndex'][number]): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(entry.uri));
  if (!workspaceFolder) {
    return entry.relativePath;
  }

  return `${workspaceFolder.uri.toString()}::${entry.relativePath}`;
}

function createPersistenceConfigHash(
  config: FastIndexerConfig,
  ignoreInputs: Array<{ path: string; rules?: string[]; missing?: boolean; }>
): string {
  return JSON.stringify({
    include: config.include,
    exclude: config.exclude,
    ignoreFiles: config.ignoreFiles,
    sharedIgnoreFiles: config.sharedIgnoreFiles,
    ignoreInputs,
    maxFileSizeKb: config.maxFileSizeKb,
    semanticEnrichment: config.semanticEnrichment,
    semanticConcurrency: config.semanticConcurrency,
    semanticTimeoutMs: config.semanticTimeoutMs,
    symbolProviderTimeoutMs: config.symbolProviderTimeoutMs
  });
}

async function getDocumentSymbolsForBuild(
  file: vscode.Uri,
  timeoutMs: number
): Promise<
  | { timedOut: false; symbols: Awaited<ReturnType<typeof getDocumentSymbols>>; }
  | { timedOut: true; }
> {
  if (timeoutMs <= 0) {
    return {
      timedOut: false,
      symbols: await getDocumentSymbols(file)
    };
  }

  return raceWithTimeout(getDocumentSymbols(file), timeoutMs);
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<
  | { timedOut: false; symbols: T; }
  | { timedOut: true; }
> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve({ timedOut: true });
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ timedOut: false, symbols: value });
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function createIndexBuildStatusReporter(statusItem: vscode.StatusBarItem): IndexBuildStatusReporter {
  let activeToken = 0;
  let state: IndexBuildProgress | undefined;

  const render = (): void => {
    if (!state) {
      return;
    }

    const action = state.kind === 'rebuild' ? 'rebuilding' : 'indexing';
    statusItem.text = state.phase === 'discovering'
      ? '$(sync~spin) Fast Indexer: scanning workspace...'
      : `$(sync~spin) Fast Indexer: ${action} ${state.processedFiles}/${state.totalFiles ?? 0}`;
    statusItem.tooltip = createIndexBuildTooltip(state);
    statusItem.show();
  };

  return {
    start: (token, kind) => {
      activeToken = token;
      state = {
        phase: 'discovering',
        kind,
        processedFiles: 0,
        skippedFiles: 0,
        symbolTimeouts: 0,
        startedAt: Date.now()
      };
      render();
    },
    setTotalFiles: (token, totalFiles) => {
      if (token !== activeToken || !state) {
        return;
      }

      state = {
        ...state,
        phase: 'indexing',
        totalFiles
      };
      render();
    },
    advance: (token, update) => {
      if (token !== activeToken || !state) {
        return;
      }

      state = {
        ...state,
        phase: 'indexing',
        ...update
      };
      render();
    },
    finish: (token) => {
      if (token !== activeToken) {
        return;
      }

      activeToken = 0;
      state = undefined;
      statusItem.hide();
      statusItem.tooltip = undefined;
    }
  };
}

function createIndexBuildTooltip(state: IndexBuildProgress): string {
  const lines = [
    state.phase === 'discovering'
      ? 'Scanning workspace for files to index.'
      : `Processed ${state.processedFiles} of ${state.totalFiles ?? 0} files.`,
    `Skipped files: ${state.skippedFiles}`,
    `Symbol timeouts: ${state.symbolTimeouts}`,
    `Elapsed: ${Math.max(0, Math.round((Date.now() - state.startedAt) / 1000))}s`
  ];

  if (state.currentFile) {
    lines.unshift(`Current file: ${state.currentFile}`);
  }

  return lines.join('\n');
}

function isPersistedSnapshotValid(
  snapshot: PersistedWorkspaceSnapshot,
  workspacePersistence: WorkspacePersistence,
  persistenceConfigHash: string
): boolean {
  return snapshot.metadata.schemaVersion === PERSISTENCE_SCHEMA_VERSION
    && snapshot.metadata.workspaceId === workspacePersistence.workspaceId
    && snapshot.metadata.configHash === persistenceConfigHash;
}

function getWorkspacePersistence(): WorkspacePersistence {
  const workspaceFolderUris = (vscode.workspace.workspaceFolders ?? [])
    .map((workspaceFolder) => workspaceFolder.uri.toString())
    .sort();

  if (workspaceFolderUris.length === 0) {
    return {
      workspaceId: 'workspace'
    };
  }

  if (workspaceFolderUris.length === 1) {
    return {
      workspaceId: encodeURIComponent(workspaceFolderUris[0]!)
    };
  }

  return {
    workspaceId: encodeURIComponent(JSON.stringify(workspaceFolderUris))
  };
}

function toGlobExpression(patterns: string[], fallback: string): string {
  const normalized = patterns.filter((pattern) => pattern.trim().length > 0);
  if (normalized.length === 0) {
    return fallback;
  }

  if (normalized.length === 1) {
    return normalized[0]!;
  }

  return `{${normalized.join(',')}}`;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function getWatcherFilters(config: FastIndexerConfig, ignoreMatcher: IgnoreMatcher): WatcherPathFilters {
  return {
    include: config.include,
    exclude: config.exclude,
    ignoreMatcher
  };
}

function createSemanticService(
  semanticIndex: SemanticIndex,
  config: FastIndexerConfig,
  output: vscode.OutputChannel
): SemanticEnrichmentService {
  return new SemanticEnrichmentService(semanticIndex, {
    enabled: config.semanticEnrichment,
    concurrency: config.semanticConcurrency,
    timeoutMs: config.semanticTimeoutMs,
    providers: {
      getDefinitions,
      getDeclarations,
      getTypeDefinitions,
      getImplementations: getImplementationsAt,
      getReferences: getReferencesAt,
      getHoverSummary
    },
    onError: (message) => output.appendLine(message)
  });
}

function normalizeWorkspaceFilePath(filePath: string): string {
  return path.normalize(filePath).toLowerCase();
}
