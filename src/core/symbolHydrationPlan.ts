import * as vscode from 'vscode';

export type SymbolHydrationReason = 'open' | 'changed' | 'breadth';

export type SymbolHydrationCandidate = {
  uri: vscode.Uri;
  relativePath: string;
  contentHash: string;
};

export type SymbolHydrationPlanOptions = {
  openPaths: Set<string>;
  changedPaths: Set<string>;
  hydratedPaths: Set<string>;
};

export type SymbolHydrationPlanItem = SymbolHydrationCandidate & {
  reason: SymbolHydrationReason;
  priority: number;
};

export type SymbolHydrationPlan = {
  items: SymbolHydrationPlanItem[];
};

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

function depth(relativePath: string): number {
  return normalizeRelativePath(relativePath).split('/').length;
}

function reasonFor(candidate: SymbolHydrationCandidate, options: SymbolHydrationPlanOptions): SymbolHydrationReason {
  const normalizedRelativePath = normalizeRelativePath(candidate.relativePath);

  if (options.openPaths.has(normalizedRelativePath)) {
    return 'open';
  }
  if (options.changedPaths.has(normalizedRelativePath)) {
    return 'changed';
  }
  return 'breadth';
}

function priorityFor(reason: SymbolHydrationReason): number {
  return reason === 'open'
    ? 0
    : reason === 'changed'
      ? 1
      : 2;
}

export function createSymbolHydrationPlan(
  candidates: SymbolHydrationCandidate[],
  options: SymbolHydrationPlanOptions
): SymbolHydrationPlan {
  const items = candidates
    .filter((candidate) => !options.hydratedPaths.has(normalizeRelativePath(candidate.relativePath)))
    .map((candidate): SymbolHydrationPlanItem => {
      const reason = reasonFor(candidate, options);
      return {
        ...candidate,
        reason,
        priority: priorityFor(reason)
      };
    })
    .sort((left, right) =>
      left.priority - right.priority ||
      depth(left.relativePath) - depth(right.relativePath) ||
      left.relativePath.localeCompare(right.relativePath)
    );

  return { items };
}
