// Moves the first download into the service worker's prefetched "shell" group.
// The initial shared chunks are named chunk-<hash>.js like the lazy shared ones,
// so no glob in ngsw-config.json can tell them apart; index.html can. Run after
// `ng build`; does nothing for builds without a service worker.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '../dist/web/browser');
const manifestFile = join(dist, 'ngsw.json');
if (existsSync(manifestFile)) {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const initial = new Set([...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => `/${m[1].replace(/^\//, '')}`));
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const shell = manifest.assetGroups.find((g) => g.name === 'shell');
  for (const group of manifest.assetGroups) {
    if (group === shell) continue;
    const moved = group.urls.filter((u) => initial.has(u));
    group.urls = group.urls.filter((u) => !initial.has(u));
    shell.urls.push(...moved);
  }
  const missing = [...initial].filter((u) => !shell.urls.includes(u));
  if (missing.length) throw new Error(`ngsw.json: the first download is missing from the shell group: ${missing.join(', ')}`);
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}
