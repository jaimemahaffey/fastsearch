import { minimatch } from 'minimatch';
import type { IgnoreMatcher } from './ignoreRules';

export const WORKSPACE_FILE_EXCLUDE_GLOB = '**/{node_modules,.git,.hg,.svn,.vscode-test,.worktrees,dist,build,coverage,out,target}/**';

export type UpdateJob =
  | { type: 'create'; relativePath: string; filePath?: string }
  | { type: 'delete'; relativePath: string; filePath?: string }
  | { type: 'change'; relativePath: string; filePath?: string };

export type WatcherPathFilters = {
  include: string[];
  exclude: string[];
  ignoreMatcher?: IgnoreMatcher;
};

const EXCLUDED_PATH_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.vscode-test',
  '.worktrees',
  'dist',
  'build',
  'coverage',
  'out',
  'target'
]);

export function normalizeFileChange(change: { type: 'rename'; from: string; to: string }): UpdateJob[] {
  return [
    { type: 'delete', relativePath: change.from },
    { type: 'create', relativePath: change.to }
  ];
}

export function shouldProcessUpdateJob(
  job: UpdateJob,
  filters: WatcherPathFilters = { include: ['**/*'], exclude: [] }
): boolean {
  const normalizedPath = job.relativePath.replace(/\\/g, '/');
  const pathSegments = normalizedPath.split('/');
  if (pathSegments.some((segment) => EXCLUDED_PATH_SEGMENTS.has(segment))) {
    return false;
  }

  const included = filters.include.length > 0 && filters.include.some((pattern) => matchesGlob(normalizedPath, pattern));
  const excluded = filters.exclude.some((pattern) => matchesGlob(normalizedPath, pattern));
  if (!included || excluded) {
    return false;
  }

  if (filters.ignoreMatcher && job.filePath && filters.ignoreMatcher.ignores(job.filePath, job.relativePath)) {
    return false;
  }

  return true;
}

function matchesGlob(value: string, pattern: string): boolean {
  return minimatch(value, pattern.replace(/\\/g, '/'), {
    dot: true,
    nocase: false,
    windowsPathsNoEscape: true
  });
}
