import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@onengo\/kernel\/(.*)$/, replacement: `${fileURLToPath(new URL('./packages/kernel/src', import.meta.url))}/$1/index.ts` },
      { find: /^@onengo\/kernel$/, replacement: fileURLToPath(new URL('./packages/kernel/src/index.ts', import.meta.url)) },
      ...['main', 'operator', 'contracts', 'browser', 'deployment', 'testing'].map((name) => ({
        find: `@onengo/platform/${name}`,
        replacement: fileURLToPath(new URL(`./packages/platform/src/api/${name}.ts`, import.meta.url)),
      })),
      { find: '@onengo/platform/icons', replacement: fileURLToPath(new URL('./packages/platform/src/runtime/definitions/icon-names.ts', import.meta.url)) },
      { find: /^@onengo\/server\/(.*)$/, replacement: `${fileURLToPath(new URL('./apps/onengo/server/src', import.meta.url))}/$1` },
    ],
  },
  test: {
    root,
    include: [
      'packages/kernel/test/**/*.test.ts',
      'packages/web-kit/test/**/*.test.ts',
      'packages/platform/test/**/*.test.ts',
      'packages/platform/src/infrastructure/contract-tests/**/*.test.ts',
      'apps/onengo/server/test/**/*.test.ts',
      'apps/onengo-console/server/test/**/*.test.ts',
      'apps/onengo/web/src/**/*.test.ts',
      'apps/onengo-console/web/src/**/*.test.ts',
      'apps/onengo-guide/web/src/**/*.test.ts',
    ],
    globalSetup: ['packages/platform/test/global-setup.ts'],
    setupFiles: ['packages/platform/test/setup-text.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // More workers than this overload one local PostgreSQL and tests time out.
    maxWorkers: 6,
  },
});
