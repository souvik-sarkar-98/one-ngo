// Stages one server for Cloud Run. Secrets are not written here: the workflow
// stores them in Secret Manager and mounts them on the service.
//
//   node .github/scripts/stage-cloud-run.mjs <server-dir> <dest>

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error('Usage: node .github/scripts/stage-cloud-run.mjs <server-dir> <dest>');
  process.exit(1);
}

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await cp(join(src, 'dist'), join(dest, 'dist'), { recursive: true });

const pkg = JSON.parse(await readFile(join(src, 'dist', 'package.json'), 'utf8'));
pkg.scripts = { ...pkg.scripts, start: 'node --enable-source-maps dist/server.js' };
await writeFile(join(dest, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
await writeFile(join(dest, '.gcloudignore'), 'node_modules/\n.git/\n');
await writeFile(join(dest, 'Dockerfile'), [
  'FROM node:22-slim',
  'WORKDIR /app',
  'COPY package.json ./',
  'COPY dist ./dist',
  'RUN npm install --omit=dev && chown -R node:node /app',
  'USER node',
  'ENV NODE_ENV=production',
  'EXPOSE 8080',
  'CMD ["node", "--enable-source-maps", "dist/server.js"]',
  '',
].join('\n'));
console.log(`Staged ${src} for Cloud Run.`);
