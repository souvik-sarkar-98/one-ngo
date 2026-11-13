import { Script, createContext } from 'node:vm';

export const PATTERN_MAX_LENGTH = 200;
const MATCH_TIMEOUT_MS = 500;
const matcher = new Script('re.test(value)');
const sandbox = createContext({ re: /^$/, value: '' });
const compiled = new Map<string, RegExp>();

/**
 * Whether the whole value matches. Runs with a time limit as a second guard
 * behind the publish-time safety check; a pattern that runs out of time
 * counts as not matching.
 */
export function matchesPattern(source: string, value: string): boolean {
  let re = compiled.get(source);
  if (!re) {
    re = new RegExp(`^(?:${source})$`, 'u');
    if (compiled.size > 500) compiled.clear();
    compiled.set(source, re);
  }
  sandbox.re = re;
  sandbox.value = value;
  try {
    return matcher.runInContext(sandbox, { timeout: MATCH_TIMEOUT_MS }) === true;
  } catch {
    return false;
  }
}

const REPEAT = new Set(['*', '+', '{']);

/**
 * True when a group that already repeats is itself repeated, such as (a+)+ or
 * (\d*){2,}: the shape that makes regular expressions take exponential time.
 */
function hasNestedRepeat(source: string): boolean {
  const groups: boolean[] = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === '(') {
      groups.push(false);
      if (source[i + 1] === '?') {
        while (i < source.length && !':=!>'.includes(source[i + 1] ?? ':')) i++;
        i++;
      }
    } else if (c === ')') {
      const repeats = groups.pop() ?? false;
      if (repeats && REPEAT.has(source[i + 1] ?? '')) return true;
      if (repeats && groups.length) groups[groups.length - 1] = true;
    } else if (REPEAT.has(c) && groups.length) {
      groups[groups.length - 1] = true;
    }
  }
  return false;
}

/** A reason the pattern cannot be published, or null when it is safe. */
export function checkPattern(source: string): string | null {
  if (source.length > PATTERN_MAX_LENGTH) return `patterns can be at most ${PATTERN_MAX_LENGTH} characters`;
  try {
    new RegExp(source, 'u');
  } catch {
    return 'is not a valid regular expression';
  }
  if (/\\[1-9]|\\k</.test(source)) return 'back-references are not allowed';
  if (hasNestedRepeat(source)) return 'repeats inside repeats are not allowed because they can make checks very slow';
  return null;
}
