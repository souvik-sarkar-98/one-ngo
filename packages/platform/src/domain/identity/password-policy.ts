import { validationFailed } from '@onengo/kernel/errors';
import type { CommonPasswordSource, Logger, PasswordBreachSource } from '@onengo/kernel/ports';
import { silentLogger } from '../silent-logger.js';
import { BUILT_IN_COMMON_PASSWORDS, normalisePassword } from './common-passwords.js';

export interface PasswordPolicyOptions {
  minLength?: number;
  maxLength?: number;
  /** 'online' asks `breaches` whether the password appeared in known breaches. */
  breachCheck?: 'online' | 'off';
  /** Refuse when the password appeared in at least this many breaches. */
  breachThreshold?: number;
  /** Extra common passwords, one per line (e.g. a published top-100,000 list). */
  commonPasswords?: CommonPasswordSource;
  /** The breach lookup used when breachCheck is 'online'. */
  breaches?: PasswordBreachSource;
  logger?: Logger;
}

export interface PasswordContext {
  email?: string | null;
  displayName?: string | null;
  organisationNames?: string[];
}

const SEQUENCES = ['abcdefghijklmnopqrstuvwxyz', '01234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/** True when the whole password is one character repeated, or a run along the alphabet, digits, or a keyboard row. */
function isTrivialPattern(p: string): boolean {
  if (/^(.)\1+$/.test(p)) return true;
  if (/^(.{1,4})\1+$/.test(p)) return true;
  for (const s of SEQUENCES) {
    const both = [s, [...s].reverse().join('')];
    if (both.some((seq) => seq.includes(p))) return true;
  }
  return false;
}

/** Name-like pieces of the person and organisation that should not form most of a password. */
function contextWords(ctx: PasswordContext): string[] {
  const words = new Set<string>();
  const add = (s: string | null | undefined) => {
    for (const part of normalisePassword(s ?? '').split(/[^\p{L}\p{N}]+/u)) if (part.length >= 3) words.add(part);
  };
  add(ctx.email?.split('@')[0]);
  add(ctx.displayName);
  for (const o of ctx.organisationNames ?? []) add(o);
  return [...words].sort((a, b) => b.length - a.length);
}

/** What is left of the password once the person's and organisation's own words are removed. */
function withoutContext(compact: string, words: string[]): string {
  let rest = compact;
  for (const w of words) rest = rest.split(w).join('');
  return rest;
}

/**
 * Rules applied whenever a password is set: length, a common-password list,
 * trivial patterns, the person's own details, and optionally known breaches.
 */
export class PasswordPolicy {
  private readonly common: Set<string>;
  private readonly min: number;
  private readonly max: number;
  private readonly logger: Logger;

  constructor(private readonly options: PasswordPolicyOptions = {}) {
    this.min = options.minLength ?? 10;
    this.max = options.maxLength ?? 200;
    this.logger = options.logger ?? silentLogger;
    this.common = new Set(BUILT_IN_COMMON_PASSWORDS.map(normalisePassword));
    if (options.commonPasswords) {
      for (const line of options.commonPasswords.lines()) {
        const p = normalisePassword(line.trim());
        if (p.length >= this.min) this.common.add(p);
      }
    }
  }

  get commonListSize(): number {
    return this.common.size;
  }

  async check(password: string, ctx: PasswordContext = {}): Promise<void> {
    if (password.length < this.min) throw validationFailed(`Use at least ${this.min} characters.`);
    if (password.length > this.max) throw validationFailed('Password is too long.');
    const p = normalisePassword(password);
    if (this.common.has(p) || isTrivialPattern(p)) {
      throw validationFailed('This password is too easy to guess. Try a short sentence instead.');
    }
    const compact = p.replace(/[^\p{L}\p{N}]+/gu, '');
    const words = contextWords(ctx);
    if (words.some((w) => compact.includes(w)) && withoutContext(compact, words).length < 6) {
      throw validationFailed('Do not build your password around your name, email, or organisation.');
    }
    if ((this.options.breachCheck ?? 'off') === 'online') await this.checkBreaches(password);
  }

  private async checkBreaches(password: string): Promise<void> {
    let count: number | null;
    try {
      if (!this.options.breaches) throw new Error('no breach source');
      count = await this.options.breaches.breachCount(password);
    } catch (error) {
      // Never block a reset because the breach service is unreachable.
      this.logger.log('WARNING', 'Breached-password check skipped', {}, error);
      return;
    }
    if (count !== null && count >= (this.options.breachThreshold ?? 1)) {
      throw validationFailed('This password has appeared in a data breach. Choose a different one.');
    }
  }
}
