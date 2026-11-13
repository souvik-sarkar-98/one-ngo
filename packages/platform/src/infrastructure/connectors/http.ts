import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

import type { ConnectorHttp, ConnectorResponse } from '../../application/connectors/ports/connector-runtime.js';

export type { ConnectorHttp, ConnectorRequest, ConnectorResponse } from '../../application/connectors/ports/connector-runtime.js';

export interface ConnectorHttpOptions {
  timeoutMs?: number;
  /**
   * Host names (exact, case-insensitive) an installation administrator allows
   * to resolve to private or internal addresses, such as an on-premises SMS
   * gateway. `CONNECTOR_ALLOWED_HOSTS`.
   */
  allowedHosts?: readonly string[];
  /** Name resolution; replaced in tests. */
  lookup?: typeof dnsLookup;
}

const REFUSED = 'Not sent: the connector address is not a public internet address. An installation administrator can allow this host.';

/** IPv4 ranges that are not public internet addresses (RFC 6890 and successors). */
const IPV4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/** IPv6 ranges that are not public; IPv4-mapped, NAT64 and 6to4 addresses are judged by the IPv4 address they carry. */
const IPV6_BLOCKED: [string, number][] = [
  ['::', 128],
  ['::1', 128],
  ['::', 96],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];

function ipv4ToInt(address: string): number {
  return address.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}

function ipv6ToBigInt(address: string): bigint {
  let text = address.split('%')[0]!.toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const n = ipv4ToInt(v4[1]!);
    text = `${text.slice(0, -v4[1]!.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = text.split('::') as [string, string | undefined];
  const left = head ? head.split(':') : [];
  const right = tail === undefined ? [] : tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g || '0', 16)), 0n);
}

const inV4 = (n: number, [base, bits]: [string, number]) => bits === 0 || n >>> (32 - bits) === ipv4ToInt(base) >>> (32 - bits);
const inV6 = (n: bigint, [base, bits]: [string, number]) => n >> BigInt(128 - bits) === ipv6ToBigInt(base) >> BigInt(128 - bits);

/** Whether `address` (an IPv4 or IPv6 literal) is a public internet address. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address.split('%')[0]!);
  if (family === 4) {
    const n = ipv4ToInt(address);
    return !IPV4_BLOCKED.some((r) => inV4(n, r)) && n !== 0xffffffff;
  }
  if (family !== 6) return false;
  const n = ipv6ToBigInt(address);
  const carried =
    n >> 32n === 0xffffn // ::ffff:a.b.c.d
      ? n & 0xffffffffn
      : n >> 32n === 0x0064ff9b0000000000000000n // 64:ff9b::/96
        ? n & 0xffffffffn
        : n >> 112n === 0x2002n // 2002::/16
          ? (n >> 80n) & 0xffffffffn
          : undefined;
  if (carried !== undefined) {
    const v4 = Number(carried);
    return isPublicAddress([v4 >>> 24, (v4 >>> 16) & 255, (v4 >>> 8) & 255, v4 & 255].join('.'));
  }
  return !IPV6_BLOCKED.some((r) => inV6(n, r));
}

const bareHost = (hostname: string) => hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();

/** `CONNECTOR_ALLOWED_HOSTS`: comma-separated host names; empty means none. */
export function connectorAllowedHosts(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((h) => bareHost(h.trim()))
    .filter(Boolean);
}

/**
 * A resolver for the connection that refuses non-public addresses, so the
 * address checked is the address connected to (no second lookup to rebind).
 */
export function publicOnlyLookup(allowed: ReadonlySet<string>, lookup: typeof dnsLookup = dnsLookup): LookupFunction {
  return ((hostname: string, options: { all?: boolean } & Record<string, unknown>, callback: (...args: unknown[]) => void) => {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = addresses as LookupAddress[];
      if (!list.length || (!allowed.has(bareHost(hostname)) && list.some((a) => !isPublicAddress(a.address)))) {
        return callback(new Error(REFUSED));
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0]!.address, list[0]!.family);
    });
  }) as LookupFunction;
}

/**
 * Calls connector services over https. Redirects are never followed, and
 * private, loopback, link-local, metadata and other non-public addresses
 * are refused (S4-15) unless the host is in `allowedHosts`.
 */
export function fetchConnectorHttp(options: ConnectorHttpOptions = {}): ConnectorHttp {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const allowed = new Set((options.allowedHosts ?? []).map(bareHost));
  const lookup = publicOnlyLookup(allowed, options.lookup);
  return (request) =>
    new Promise<ConnectorResponse>((resolve, reject) => {
      const url = new URL(request.url);
      if (url.protocol !== 'https:') return reject(new Error('Not sent: connectors call https:// addresses only.'));
      const host = bareHost(url.hostname);
      if (isIP(host) && !allowed.has(host) && !isPublicAddress(host)) return reject(new Error(REFUSED));
      if ((host === 'localhost' || host.endsWith('.localhost')) && !allowed.has(host)) return reject(new Error(REFUSED));
      const headers = request.body === undefined ? request.headers : { 'content-length': String(Buffer.byteLength(request.body)), ...request.headers };
      const maxBody = request.maxBodyBytes ?? 2000;
      const req = httpsRequest(url, { method: request.method, headers, lookup }, (res) => {
        let body = '';
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({ status: res.statusCode ?? 0, body: body.slice(0, maxBody) });
        };
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          if (body.length >= maxBody) {
            finish();
            res.destroy();
          }
        });
        res.on('end', finish);
        res.on('error', (error) => {
          if (!done) reject(error);
        });
      });
      const timer = setTimeout(
        () => req.destroy(new Error('The service did not answer in time.')),
        request.timeoutMs ?? timeoutMs,
      );
      req.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      req.end(request.body);
    });
}
