import { minimatch } from 'minimatch';

export const WORKSPACE_FILE_EXCLUDE_GLOB = '**/{node_modules,.git,.hg,.svn,dist,build,coverage,out,target}/**';

export type UpdateJob =
  | { type: 'create'; relativePath: string }
  | { type: 'delete'; relativePath: string }
  | { type: 'change'; relativePath: string };

export type WatcherPathFilters = {
  include: string[];
  exclude: string[];
};

const EXCLUDED_PATH_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
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
  return included && !excluded;
}

function matchesGlob(value: string, pattern: string): boolean {
  return minimatch(value, pattern.replace(/\\/g, '/'), {
    dot: true,
    nocase: false,
    windowsPathsNoEscape: true
  });
}
