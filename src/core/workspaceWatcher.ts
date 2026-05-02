export type UpdateJob =
  | { type: 'create'; relativePath: string }
  | { type: 'delete'; relativePath: string }
  | { type: 'change'; relativePath: string };

export function normalizeFileChange(change: { type: 'rename'; from: string; to: string }): UpdateJob[] {
  return [
    { type: 'delete', relativePath: change.from },
    { type: 'create', relativePath: change.to }
  ];
}
