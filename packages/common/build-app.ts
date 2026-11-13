import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build, type Plugin } from 'esbuild';

type AppName = 'onengo' | 'onengo-console';
type Dependencies = Record<string, string>;

interface PackageJson {
  name?: string;
  dependencies?: Dependencies;
  exports?: Record<string, string>;
}

interface AppConfig {
  serverDir: string;
  webDir: string;
  artifactName: string;
  entries: Record<string, string>;
  platformExports: ReadonlySet<string>;
}

interface AngularBuildOptions {
  outputPath?: string | { base?: string; browser?: string };
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const platformDir = join(root, 'packages/platform');
const productDir = join(root, 'packages/product');
const kernelDir = join(root, 'packages/kernel');

const apps: Record<AppName, AppConfig> = {
  onengo: {
    serverDir: 'apps/onengo/server',
    webDir: 'apps/onengo/web',
    artifactName: '@onengo/server-artifact',
    entries: {
      server: 'apps/onengo/server/src/main.ts',
      deploy: 'apps/onengo/server/src/deploy.ts',
      'sandbox-worker': 'packages/platform/src/runtime/scripts/sandbox-worker.ts',
    },
    platformExports: new Set(['main', 'contracts', 'deployment']),
  },
  'onengo-console': {
    serverDir: 'apps/onengo-console/server',
    webDir: 'apps/onengo-console/web',
    artifactName: '@onengo-console/server-artifact',
    entries: {
      server: 'apps/onengo-console/server/src/main.ts',
    },
    platformExports: new Set(['operator', 'contracts']),
  },
};

function selectApp(name: string | undefined): AppName {
  if (name === 'onengo' || name === 'main') return 'onengo';
  if (name === 'onengo-console' || name === 'operator') return 'onengo-console';
  throw new Error('Choose an app to build: onengo or onengo-console.');
}

/** Browser output of the web project's Angular build, from its angular.json. */
async function browserOutput(webDir: string): Promise<string> {
  const angular = JSON.parse(await readFile(join(webDir, 'angular.json'), 'utf8')) as {
    projects?: Record<string, { architect?: { build?: { options?: AngularBuildOptions } } }>;
  };
  const outputPath = Object.values(angular.projects ?? {})[0]?.architect?.build?.options?.outputPath;
  if (!outputPath) throw new Error(`No build outputPath in ${join(webDir, 'angular.json')}.`);
  const base = typeof outputPath === 'string' ? outputPath : outputPath.base;
  if (!base) throw new Error(`No build output path base in ${join(webDir, 'angular.json')}.`);
  const browser = typeof outputPath === 'string' || outputPath.browser === undefined ? 'browser' : outputPath.browser;
  return join(webDir, base, browser);
}

const appName = selectApp(process.argv[2]);
const app = apps[appName];
const production = process.argv.includes('--production');
if (production && process.argv.includes('--development')) throw new Error('Choose either --production or --development.');
const mode = production ? 'production' : 'development';
const startedAt = Date.now();

function log(event: string, details: Record<string, string | number> = {}): void {
  const fields = Object.entries(details).map(([key, value]) => `${key}=${value}`).join(' ');
  console.log(`[build-app] ${appName} ${mode} ${event}${fields ? ` ${fields}` : ''}`);
}

const readPackage = async (directory: string): Promise<PackageJson> =>
  JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as PackageJson;
const platformPackage = await readPackage(platformDir);
const kernelPackage = await readPackage(kernelDir);
const serverDir = join(root, app.serverDir);
const serverPackage = await readPackage(serverDir);
const dist = join(serverDir, 'dist');

interface Workspace {
  directory: string;
  exports: Record<string, string>;
  allowed?: ReadonlySet<string>;
}

function workspaceResolver(): Plugin {
  const packages = new Map<string, Workspace>([
    ['@onengo/platform', { directory: platformDir, exports: platformPackage.exports ?? {}, allowed: app.platformExports }],
    ['@onengo/kernel', { directory: kernelDir, exports: kernelPackage.exports ?? {} }],
  ]);
  return {
    name: 'bundle-private-workspaces',
    setup(builder) {
      builder.onResolve({ filter: /^@onengo\/(?:platform|kernel)(?:\/.*)?$/ }, (args) => {
        const packageName = args.path.match(/^@onengo\/[^/]+/)?.[0];
        const workspace = packageName ? packages.get(packageName) : undefined;
        if (!packageName || !workspace) return undefined;
        const subpath = args.path === packageName ? '.' : `.${args.path.slice(packageName.length)}`;
        const exportName = subpath === '.' ? '' : subpath.slice(2);
        if (workspace.allowed && !workspace.allowed.has(exportName)) {
          throw new Error(`${app.serverDir} may not import ${args.path}`);
        }
        const target = workspace.exports[subpath];
        if (!target) throw new Error(`${args.path} is not a declared package export`);
        return { path: join(workspace.directory, target.replace(/^\.\//, '')) };
      });
    },
  };
}

const webDir = join(root, app.webDir);
const webPackage = await readPackage(webDir);
if (!webPackage.name) throw new Error(`Set name in ${join(webDir, 'package.json')}.`);
const webOutput = await browserOutput(webDir);

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Build through npm so the web workspace uses the installed toolchain.');
log('web.build.started', { workspace: webPackage.name });
await promisify(execFile)(process.execPath, [npmCli, 'run', 'build', '--workspace', webPackage.name], {
  cwd: root,
  windowsHide: true,
});
log('web.build.completed');

log('server.bundle.started', { entries: Object.keys(app.entries).length });
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: app.entries,
  outdir: dist,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  minify: production,
  treeShaking: true,
  sourcemap: production ? false : 'linked',
  define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') },
  plugins: [workspaceResolver()],
});
log('server.bundle.completed');

log('assets.copy.started');
const artifactProduct = join(dist, 'product');
await cp(join(platformDir, 'migrations'), join(artifactProduct, 'migrations'), { recursive: true });
for (const directory of ['locale', 'schemas', 'modules']) {
  await cp(join(productDir, directory), join(artifactProduct, directory), { recursive: true });
}
await cp(webOutput, join(dist, 'web'), { recursive: true, force: true });
log('assets.copy.completed');

const dependencies: Dependencies = {
  ...kernelPackage.dependencies,
  ...platformPackage.dependencies,
  ...serverPackage.dependencies,
};
for (const name of Object.keys(dependencies)) {
  if (name.startsWith('@onengo/')) delete dependencies[name];
}
await writeFile(join(dist, 'package.json'), `${JSON.stringify({
  name: app.artifactName,
  private: true,
  type: 'module',
  engines: { node: '>=22' },
  dependencies,
}, null, 2)}\n`);

log('build.completed', {
  artifact: relative(root, dist),
  dependencies: Object.keys(dependencies).length,
  durationMs: Date.now() - startedAt,
});
