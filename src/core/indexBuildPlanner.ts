import * as vscode from 'vscode';

export type IndexCandidate = {
  uri: vscode.Uri;
  relativePath: string;
};

export type IndexReuseHints = {
  file: Set<string>;
  text: Set<string>;
  symbol: Set<string>;
};

export type IndexBuildPlan = {
  filePhase: IndexCandidate[];
  textPhase: IndexCandidate[];
  symbolPhase: IndexCandidate[];
};

export function createIndexBuildPlan(
  candidates: IndexCandidate[],
  reuseHints: IndexReuseHints
): IndexBuildPlan {
  const sorted = [...candidates].sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  return {
    filePhase: sorted.filter((candidate) => !reuseHints.file.has(candidate.relativePath)),
    textPhase: sorted.filter((candidate) => !reuseHints.text.has(candidate.relativePath)),
    symbolPhase: sorted.filter((candidate) => !reuseHints.symbol.has(candidate.relativePath))
  };
}
