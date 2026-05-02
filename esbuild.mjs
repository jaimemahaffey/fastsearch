import { readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { build } from 'esbuild';

function collectEntryPoints(directory) {
  const entries = [];

  for (const name of readdirSync(directory)) {
    const fullPath = path.join(directory, name);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      entries.push(...collectEntryPoints(fullPath));
      continue;
    }

    if (fullPath.endsWith('.ts')) {
      entries.push(fullPath);
    }
  }

  return entries;
}

await build({
  entryPoints: collectEntryPoints('src'),
  outdir: 'dist',
  outbase: 'src',
  bundle: false,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  target: 'node20'
});
