import { describe, expect, it } from 'vitest';
import { APPROVAL_SORTS, INBOX_PARAMS } from '../core/inbox/address';
import { APPROVAL_FIELDS, approvalColumns, approvalRow, approvalSortOptions, approvalValues } from '../core/inbox/rows';
import { inboxHarness } from '../core/inbox/testing';
import { t } from '../core/i18n/i18n';
import type { ApprovalRow } from '../core/models';
import type { RowView } from '../core/rows';

const now = new Date('2026-10-04T00:00:00.000Z');

/** Every piece of text a card shows. */
const cardText = (r: RowView) => [r.title, r.subtitle ?? '', ...(r.lines ?? []), r.meta ?? '', r.badge?.label ?? ''];

async function loaded(): Promise<ApprovalRow[]> {
  const h = inboxHarness({ tab: 'approvals' });
  await h.start();
  return h.session.rows.items;
}

describe('approvals: cards and table show the same thing', () => {
  it('the table has exactly the common workflow fields as columns, and a cell for each', async () => {
    expect(approvalColumns().map((c) => c.key)).toEqual(['record', 'type', 'step', 'change', 'requestedBy', 'waiting', 'approvals']);
    for (const a of await loaded()) {
      expect(approvalRow(a, now).cells.map((c) => c.key)).toEqual([...APPROVAL_FIELDS]);
    }
  });

  it('a card shows every common field and nothing else', async () => {
    const template = t('ui.inbox.requestedLine', { name: '', waited: '' });
    for (const a of await loaded()) {
      const v = approvalValues(a, now);
      const card = cardText(approvalRow(a, now)).join('\n');
      const shown = [a.recordNumber ?? '', a.recordTitle, v.type, v.step, a.fromStatusLabel, a.toStatusLabel, v.requestedBy, v.waiting, v.approvals];
      for (const value of shown) expect(card, value).toContain(value);
      let rest = card;
      for (const value of [...shown].sort((x, y) => y.length - x.length)) rest = rest.split(value).join('');
      for (const word of template.split(/\s+/)) rest = rest.split(word).join('');
      expect(rest.replace(/[\s·→]/g, ''), a.id).toBe('');
    }
  });

  it('never shows record-specific fields such as the amount', async () => {
    for (const a of await loaded()) {
      const row = approvalRow(a, now);
      expect(JSON.stringify(row)).not.toMatch(/amount|₹/i);
    }
  });

  it('both layouts offer Approve and Reject on every row', async () => {
    for (const a of await loaded()) expect(approvalRow(a, now).actions.map((x) => [x.id, x.tone])).toEqual([['approve', 'primary'], ['reject', 'danger']]);
  });

  it('table headers sort the same fields as the Sort menu: Waiting since, Record, Type, Step, Requested by', () => {
    expect(approvalSortOptions().map((o) => o.key)).toEqual([...APPROVAL_SORTS]);
    expect(approvalColumns().filter((c) => c.sortable).map((c) => c.key).sort()).toEqual([...APPROVAL_SORTS].sort());
  });

  it('the layout is not part of the address, so the same actions give the same addresses on every size', () => {
    expect(INBOX_PARAMS).not.toContain('view');
  });

  it('the waiting time reads the same in both', async () => {
    const [a] = await loaded();
    const row = approvalRow(a!, now);
    expect(row.cells.find((c) => c.key === 'waiting')!.value).toBe('3 days');
    expect(row.meta).toBe('Requested by Vikram Iyer · waiting 3 days');
  });
});
