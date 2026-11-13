import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const platformRoot = join(import.meta.dirname, '..');
const sharedProductRoot = join(platformRoot, '..', 'product');

describe('product asset ownership', () => {
  it('keeps shared assets out of the platform package', () => {
    expect(existsSync(join(platformRoot, 'product'))).toBe(false);
    expect(readdirSync(sharedProductRoot).sort()).toEqual(['locale', 'modules', 'package.json', 'schemas']);
  });

  it('keeps platform-private deployment assets at the package root', () => {
    expect(readdirSync(join(platformRoot, 'migrations')).filter((file) => file.endsWith('.sql')).length).toBeGreaterThan(0);
    expect(existsSync(join(sharedProductRoot, 'modules', 'donations', 'module.json'))).toBe(true);
    expect(existsSync(join(sharedProductRoot, 'modules', 'people'))).toBe(false);
  });
});
