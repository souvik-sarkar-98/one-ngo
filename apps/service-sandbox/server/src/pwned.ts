import { createHash } from 'node:crypto';
import { BREACHED_PASSWORD, PATHS } from './constants.js';
import { header, sendText, type Handler } from './http.js';
import type { FixtureLog } from './log.js';

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex').toUpperCase();
const BREACHED = sha1(BREACHED_PASSWORD);
const BREACHED_COUNT = 52_256_179;
const FILLER = 12;
const PADDING = 8;

/**
 * The body Have I Been Pwned's range API answers for a five-character SHA-1 prefix: one `SUFFIX:COUNT` line
 * per hash, the 35-character upper-case suffix and a count. Only the hash of `password` is reported breached;
 * the other lines are made-up suffixes that no real password here hashes to. With padding, extra lines have count 0.
 */
export function rangeBody(prefix: string, padded: boolean): string {
  const upper = prefix.toUpperCase();
  const lines: string[] = [];
  for (let i = 0; i < FILLER + (padded ? PADDING : 0); i++) {
    const suffix = createHash('sha1').update(`service-sandbox:${upper}:${i}`).digest('hex').toUpperCase().slice(0, 35);
    if (`${upper}${suffix}` === BREACHED) continue;
    lines.push(`${suffix}:${i < FILLER ? (i % 7) + 1 : 0}`);
  }
  if (BREACHED.startsWith(upper)) lines.push(`${BREACHED.slice(5)}:${BREACHED_COUNT}`);
  return lines.sort().join('\r\n');
}

/** Stands in for https://api.pwnedpasswords.com/range/{prefix}. */
export function pwnedRoutes(log: FixtureLog): Handler {
  return async (req, res) => {
    if (req.method !== 'GET' || !req.url.pathname.startsWith(PATHS.pwnedRange)) return false;
    const prefix = req.url.pathname.slice(PATHS.pwnedRange.length);
    if (!/^[0-9A-Fa-f]{5}$/.test(prefix)) return sendText(res, 400, 'The hash prefix was not in a valid format');
    const breached = BREACHED.startsWith(prefix.toUpperCase());
    log.add('pwned', `Range ${prefix.toUpperCase()}${breached ? ' (contains the breached password)' : ''}`);
    return sendText(res, 200, rangeBody(prefix, header(req, 'add-padding') === 'true'));
  };
}
