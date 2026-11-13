import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Separate from the repository's test run: no database, and not part of npm run ci. */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@onengo\/kernel\/(.*)$/, replacement: `${fileURLToPath(new URL('../../../packages/kernel/src', import.meta.url))}/$1/index.ts` },
    ],
  },
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
