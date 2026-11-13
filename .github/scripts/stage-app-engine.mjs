import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error('Usage: node .github/scripts/stage-app-engine.mjs <server-dir> <dest>');
  process.exit(1);
}

await rm(dest, { recursive: true, force: true });
await mkdir(join(dest, 'dist'), { recursive: true });
await cp(join(src, 'dist'), join(dest, 'dist'), { recursive: true });

const manifest = await readFile(join(src, 'app.yaml'), 'utf8');
const tokens = [...new Set(manifest.match(/REPLACE_WITH_[A-Z0-9_]+/g) ?? [])];
const missing = tokens.filter((token) => !process.env[token]);
if (missing.length > 0) {
  console.error(`Set these values before deploy: ${missing.join(', ')}`);
  process.exit(1);
}

let resolved = manifest;
for (const token of tokens) resolved = resolved.replaceAll(token, JSON.stringify(process.env[token]));
if (resolved.includes('REPLACE_WITH_')) {
  console.error('A placeholder was still present after substitution.');
  process.exit(1);
}

await writeFile(join(dest, 'app.yaml'), resolved);
await writeFile(join(dest, 'package.json'), await readFile(join(src, 'dist', 'package.json')));
await writeFile(join(dest, '.gcloudignore'), 'node_modules/\n.git/\n');
console.log(`Staged ${src} with ${tokens.length} settings filled.`);
