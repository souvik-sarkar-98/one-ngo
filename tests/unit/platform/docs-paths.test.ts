import { describe, expect, it } from 'vitest';
import { citedPaths, expandBraces, missingDocPaths } from '../../support/platform/docs-paths.js';

describe('documentation paths', () => {
  it('cites files and folders that exist in this repository', () => {
    expect(missingDocPaths(), 'A markdown path is not on disk. Point it at the current file, or drop the citation.').toEqual([]);
  });

  it('expands the {a,b} shorthand so that every alternative is checked', () => {
    expect(expandBraces('packages/platform/src/domain/{receipts,ledger}')).toEqual(['packages/platform/src/domain/receipts', 'packages/platform/src/domain/ledger']);
    expect(expandBraces('docs/{a,b}/{c,d}.md')).toEqual(['docs/a/c.md', 'docs/a/d.md', 'docs/b/c.md', 'docs/b/d.md']);
    expect(expandBraces('docs/{placeholder}/x.md')).toEqual(['docs/{placeholder}/x.md']);
    expect(citedPaths('See `docs/{one,two}.md` and `docs/three.md`.')).toEqual(['docs/one.md', 'docs/two.md', 'docs/three.md']);
  });
});
