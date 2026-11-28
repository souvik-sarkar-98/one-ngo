import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

// Three projects (tests/e2e is Playwright and runs on its own):
//   tests/unit         needs no database
//   hygiene            a subset of unit: tests that read the TypeScript and CSS source (imports, layers,
//                      persistence, web wiring). Listed by file so each test stays where the docs cite it.
//                      Docs, config, manifests, catalogue data and utility scripts are not hygiene.
//   tests/integration  needs PostgreSQL; globalSetup creates the test database
// Shared helpers, fixtures and allowlists live in tests/support.
const HYGIENE = [
  'tests/unit/kernel/architecture.test.ts',
  'tests/unit/platform/layer-architecture.test.ts',
  'tests/unit/platform/persistence-architecture.test.ts',
  'tests/unit/platform/kysely-architecture.test.ts',
  'tests/unit/platform/owner-capabilities.test.ts',
  'tests/unit/platform/web-architecture.test.ts',
  'tests/unit/platform/package-graph.test.ts',
  'tests/unit/platform/composition.test.ts',
  'tests/unit/web-kit/import-boundary.test.ts',
  'tests/unit/web-kit/design-system.test.ts',
];
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
    setupFiles: ['tests/support/platform/setup-text.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // More workers than this overload one local PostgreSQL and tests time out.
    maxWorkers: 6,
    projects: [
      { extends: true, test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], exclude: [...configDefaults.exclude, ...HYGIENE] } },
      { extends: true, test: { name: 'hygiene', include: HYGIENE } },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          globalSetup: ['tests/support/platform/global-setup.ts'],
        },
      },
    ],
  },
});
