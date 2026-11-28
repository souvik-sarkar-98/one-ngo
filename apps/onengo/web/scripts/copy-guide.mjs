/**
 * Copies the user guide and the files it loads into `generated/guide`. The web
 * build and `ng serve` publish that folder at the site root, so the guide opens
 * at /user-guide.html. Runs before every build and before the dev server starts.
 */
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(webDir, '..', '..', '..');
const out = join(webDir, 'generated', 'guide');

/** [source in the repository, path under the published root]. user-guide.html links to these with relative paths. */
const files = [
  ['docs/user-guide.html', 'user-guide.html'],
  ['docs/assets/docs.css', 'assets/docs.css'],
  ['docs/assets/docs.js', 'assets/docs.js'],
  ['packages/web-kit/src/styles/base.css', 'packages/web-kit/src/styles/base.css'],
  ['packages/web-kit/src/styles/tokens.css', 'packages/web-kit/src/styles/tokens.css'],
];

rmSync(out, { recursive: true, force: true });
for (const [from, to] of files) {
  const target = join(out, to);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(repo, from), target);
}
console.log(`Copied the user guide to ${out}.`);
