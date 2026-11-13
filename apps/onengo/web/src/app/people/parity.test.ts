import { describe, expect, it } from 'vitest';
import { apiKeyRow, auditRow, connectorRow, jobRow, memberRow, roleRow } from '../admin/rows';
import { memoryAdmin } from '../core/admin/testing';
import { PEOPLE_PARAMS } from '../core/people/address';
import { peopleColumns, peopleSortOptions, personRow } from '../core/people/rows';
import { peopleHarness } from '../core/people/testing';
import type { RowView } from '../core/rows';

const now = new Date('2026-10-24T12:00:00.000Z');
const cardText = (r: RowView) => [r.title, r.subtitle ?? '', ...(r.lines ?? []), r.meta ?? '', r.badge?.label ?? ''].join('\n');

/** Every value a table cell shows is also on the card (empty values excepted). */
function sameValues(row: RowView): void {
  const card = cardText(row);
  for (const c of row.cells) if (c.value !== '—') expect(card, `${row.id} ${c.key}`).toContain(c.value);
}

describe('People: cards and table show the same thing', () => {
  for (const variant of ['directory', 'management'] as const) {
    it(`${variant}: each column has a cell, and every cell is on the card`, async () => {
      const h = peopleHarness(variant, variant === 'management' ? { status: 'all' } : {});
      await h.start();
      const cols = peopleColumns(variant).map((c) => c.key);
      for (const p of h.session.rows.items) {
        const row = personRow(p, variant, h.session.meta);
        expect(row.cells.map((c) => c.key)).toEqual(cols);
        sameValues(row);
      }
    });
  }

  it('table headers sort the same fields as the Sort menu', () => {
    for (const variant of ['directory', 'management'] as const) {
      const sortable = peopleColumns(variant)
        .filter((c) => c.sortable)
        .map((c) => c.key)
        .sort();
      expect(sortable).toEqual(
        peopleSortOptions(variant)
          .map((o) => o.key)
          .sort(),
      );
    }
  });

  it('the layout is not part of the address, so both give the same addresses', () => {
    expect(PEOPLE_PARAMS).not.toContain('view');
  });
});

describe('Administration lists: cards and table show the same thing', () => {
  it('roles, members, connectors, API keys, jobs and the audit log', async () => {
    const m = memoryAdmin();
    const g = m.gateway;
    const rows: RowView[] = [
      ...(await g.roles()).map(roleRow),
      ...(await g.roleMembers('finance')).items.map((p) => memberRow(p, 'finance', [{ key: 'finance', label: 'Finance' }])),
      ...(await g.connectors()).map((c) => connectorRow(c, now)),
      ...(await g.apiKeys()).map((k) => apiKeyRow(k, 'Finance', now)),
      ...(await g.jobs({ limit: 10, offset: 0 })).items.map((j) => jobRow(j, now)),
      ...(await g.audit({ limit: 5, offset: 0 })).items.map((e) => auditRow(e, () => 'Donations', now)),
    ];
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) sameValues(r);
  });
});
