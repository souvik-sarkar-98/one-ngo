/**
 * The rate-limit key for a client address. IPv6 callers usually hold a whole
 * /64, so they are keyed by that prefix; IPv4-mapped addresses key as IPv4.
 */
export function clientAddressKey(ip: string): string {
  const addr = ip.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped) return mapped[1]!;
  if (!addr.includes(':')) return addr.slice(0, 64);
  const [head = '', tail = ''] = addr.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = addr.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups
    .slice(0, 4)
    .map((g) => (g || '0').replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/** Fastify's `trustProxy`, never `true` (which would believe every X-Forwarded-For entry). */
export function proxyTrust(trust: number | string[] | undefined): ((address: string, hop: number) => boolean) | string[] | false {
  if (trust === undefined) return false;
  if (typeof trust === 'number') {
    if (!Number.isInteger(trust) || trust < 0 || trust > 10) throw new Error('trustProxy must be a hop count from 0 to 10.');
    return trust > 0 ? (_address, hop) => hop < trust : false;
  }
  return trust.length ? trust : false;
}

/**
 * `TRUST_PROXY`: a hop count or comma-separated proxy addresses / CIDR ranges.
 * Unset means 1 on App Engine (its front end appends the client address) and none elsewhere.
 */
export function trustProxyFromEnv(env: NodeJS.ProcessEnv = process.env): number | string[] | undefined {
  const raw = env.TRUST_PROXY?.trim();
  if (!raw) return env.GAE_SERVICE ? 1 : undefined;
  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    proxyTrust(hops);
    return hops;
  }
  const entries = raw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const e of entries) {
    if (!/^[0-9a-f:.]+(\/\d{1,3})?$/i.test(e)) throw new Error(`TRUST_PROXY entry must be a hop count, an address or a CIDR range: ${e}`);
  }
  return entries;
}
