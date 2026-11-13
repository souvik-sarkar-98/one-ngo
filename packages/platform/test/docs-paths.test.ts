import { describe, expect, it } from 'vitest';
import { missingDocPaths } from './docs-paths.js';

describe('documentation paths', () => {
  it('cites files and folders that exist in this repository', () => {
    expect(missingDocPaths(), 'A markdown path is not on disk. Point it at the current file, or drop the citation.').toEqual([]);
  });
});