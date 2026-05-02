export const WORKSPACE_FILE_EXCLUDE_GLOB = '**/{node_modules,.git,.hg,.svn,dist,build,coverage,out,target}/**';

export type UpdateJob =
  | { type: 'create'; relativePath: string }
  | { type: 'delete'; relativePath: string }
  | { type: 'change'; relativePath: string };

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

export function shouldProcessUpdateJob(job: UpdateJob): boolean {
  const pathSegments = job.relativePath.replace(/\\/g, '/').split('/');
  return !pathSegments.some((segment) => EXCLUDED_PATH_SEGMENTS.has(segment));
}
