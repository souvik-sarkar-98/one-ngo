/**
 * Fixture default origin. The rewrite below is only installed when `npm run dev` names a fixture
 * (see `installFixtureHostsIfConfigured`). Then Cloud Storage, the metadata token server and the
 * breached-password range API go to the local integration fixture (`npm run demo:integrations`)
 * instead; when the fixture is not running the request fails. No other host is changed.
 */
export const INTEGRATION_FIXTURE_ORIGIN = 'https://127.0.0.1:8095';

/**
 * Where this process sends the fixture hosts. `INTEGRATION_FIXTURE_ORIGIN` may name another
 * loopback https port. Anything else is ignored, so the real hosts are never used.
 */
export function fixtureOrigin(): string {
  const configured = process.env.INTEGRATION_FIXTURE_ORIGIN?.trim();
  if (!configured) return INTEGRATION_FIXTURE_ORIGIN;
  try {
    const url = new URL(configured);
    const host = url.hostname.replace(/\.$/, '').toLowerCase();
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    if (url.protocol === 'https:' && loopback && !url.username && !url.password && (url.pathname === '/' || url.pathname === '') && !url.search && !url.hash) {
      return url.origin;
    }
  } catch {
    // A bad value keeps the default fixture. It is never treated as a real host.
  }
  return INTEGRATION_FIXTURE_ORIGIN;
}

const STORAGE_HOST = 'storage.googleapis.com';
const PWNED_HOST = 'api.pwnedpasswords.com';
const METADATA_HOST = 'metadata.google.internal';
const METADATA_TOKEN_PATH = '/computeMetadata/v1/instance/service-accounts/default/token';

/** The address a request to `url` is sent to: the fixture for the three hosts above, else `url` unchanged. */
export function fixtureUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = parsed.hostname.replace(/\.$/, '');
  const pathAndQuery = `${parsed.pathname}${parsed.search}`;
  const origin = fixtureOrigin();
  if (host === STORAGE_HOST) return `${origin}${pathAndQuery}`;
  if (host === PWNED_HOST && (parsed.pathname === '/range' || parsed.pathname.startsWith('/range/'))) return `${origin}${pathAndQuery}`;
  if (host === METADATA_HOST) {
    return parsed.pathname === METADATA_TOKEN_PATH ? `${origin}/token${parsed.search}` : `${origin}${pathAndQuery}`;
  }
  return url;
}

/** `fetch` that sends the three fixture hosts to the fixture and every other request through `base` unchanged. */
export function fixtureFetch(base: typeof fetch): typeof fetch {
  return (input, init) => {
    if (typeof input === 'string') return base(fixtureUrl(input), init);
    if (input instanceof URL) {
      const target = fixtureUrl(input.href);
      return base(target === input.href ? input : target, init);
    }
    const target = fixtureUrl(input.url);
    if (target === input.url) return base(input, init);
    const { method, headers, body, signal, redirect } = input;
    return base(target, { method, headers, body, signal, redirect, duplex: 'half', ...init } as RequestInit);
  };
}

/** Replaces the process-wide `fetch`, which the file store, metadata token and breached-password check use. */
export function installFixtureHosts(target: { fetch: typeof fetch } = globalThis): void {
  target.fetch = fixtureFetch(target.fetch.bind(target));
}

/**
 * Installs the rewrite only when `INTEGRATION_FIXTURE_ORIGIN` is set, which the API dev script does.
 * Deployments never set it, so their requests are not changed.
 */
export function installFixtureHostsIfConfigured(env: NodeJS.ProcessEnv = process.env, target: { fetch: typeof fetch } = globalThis): boolean {
  if (!env.INTEGRATION_FIXTURE_ORIGIN?.trim()) return false;
  installFixtureHosts(target);
  return true;
}
