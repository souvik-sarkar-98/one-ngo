import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUPPORT_DIR } from '../../support/paths.js';
import { expiryProblems, isClosed, OPEN_BLOCKS, parseBlockStatus, readPlanStatus, type Entry as PlanEntry } from '../../support/platform/plan-status.js';

/**
 * Allowlist entries must name a block that is still open in the plan. The status comes from the plan's section 5.1 table,
 * so these tests read the plan document: they are docs checks, not source checks.
 */
describe('allowlist expiry (section 5.1 of the plan)', () => {
  it('expires layer allowlist entries whose block section 5.1 marks Merged or Done', () => {
    const allowlist = JSON.parse(readFileSync(join(SUPPORT_DIR, 'platform', 'layer-allowlist.json'), 'utf8')) as Record<string, PlanEntry>;
    expect(expiryProblems(allowlist, readPlanStatus(), OPEN_BLOCKS.allowlist), 'An expired or unapproved allowlist entry. Fix the import instead.').toEqual([]);
  });

  it('expires package allowlist entries whose block section 5.1 marks Merged or Done', () => {
    const allowlist = JSON.parse(readFileSync(join(SUPPORT_DIR, 'platform', 'package-allowlist.json'), 'utf8')) as Record<string, PlanEntry>;
    expect(expiryProblems(allowlist, readPlanStatus(), OPEN_BLOCKS.allowlist), 'An expired or unapproved package allowlist entry. Fix the import instead.').toEqual([]);
  });

  const status = (rows: Record<string, string>) => new Map(Object.entries(rows));
  const entry = (block: string): PlanEntry => ({ reason: 'a reason that is long enough to count', owner: 'runtime/records', removeAfterBlock: block });

  it('reads the block rows of section 5.1 of the plan, including escaped pipes, and stops at the next heading', () => {
    const md = [
      '## 5. Plan',
      '| Block | Status |',
      '| not | this table |',
      '### 5.1 Block status',
      '',
      '| Block | Status | Branch or commit | Notes |',
      '| --- | --- | --- | --- |',
      '| F1 | Merged | `f5b496d` | a \\| b |',
      '| **D** | Not started | x | y |',
      '| A8 | Done (server) | see branch | z |',
      '| M1 web screens | Merged | merge | `<screen> \\| OneNGO` |',
      '',
      '### 5.2 Next',
      '| Q9 | Merged | x | y |',
    ].join('\n');
    expect([...parseBlockStatus(md).entries()]).toEqual([
      ['F1', 'Merged'],
      ['D', 'Not started'],
      ['A8', 'Done (server)'],
      ['M1 web screens', 'Merged'],
    ]);
  });

  it('tells a closed block (Merged or Done) from an open one', () => {
    for (const s of ['Merged', 'Done', 'Done (server, `one-ngo`)', 'Merged into D11', 'Merged, awaiting counsel', 'merged']) expect(isClosed(s), s).toBe(true);
    for (const s of ['Not started', 'In progress (6 parallel blocks)', 'Blocked', 'Review done; findings open', '', undefined, 'Doneness', 'Unmerged']) expect(isClosed(s), String(s)).toBe(false);
  });

  it('fails an entry whose block is Merged or Done, unknown, missing or not approved as open', () => {
    const plan = status({ H: 'Not started', R: 'Merged', D: 'Done (branch)', I: 'In progress', A1: 'Done (server)', G: 'Not started' });
    const entries = {
      'open and approved': entry('H'),
      'merged block': entry('R'),
      'done block': entry('D'),
      'open but not approved': entry('G'),
      'in progress and approved': entry('I'),
      'not a row': entry('Q'),
      'old block': entry('A1'),
      'no block': entry(''),
    };
    expect(expiryProblems(entries, plan, ['H', 'R', 'D', 'I']).map((p) => p.split(':')[0])).toEqual(['merged block', 'done block', 'open but not approved', 'not a row', 'old block', 'no block']);
    expect(expiryProblems(entries, plan, ['H', 'R', 'D', 'I']).find((p) => p.startsWith('merged block'))).toContain('expired');
    expect(expiryProblems(entries, plan, []).length).toBe(8);
    expect(expiryProblems({ ok: entry('H') }, plan, ['H'])).toEqual([]);
  });

  it('has the A rows in section 5.1, all closed', () => {
    const plan = readPlanStatus();
    for (const b of ['A1', 'A8']) expect(plan.has(b), `Section 5.1 has no row ${b}.`).toBe(true);
    expect(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'].filter((b) => !isClosed(plan.get(b)))).toEqual([]);
  });
});
