import { describe, expect, it } from 'vitest';
import type { ListViewDef, RecordQueryBody } from '../../../../../../../apps/onengo/web/src/app/core/models';
import { rowModel } from '../../../../../../../apps/onengo/web/src/app/core/records/record/present';
import { RecordSession } from '../../../../../../../apps/onengo/web/src/app/core/records/record/record-session';
import { relatedQuery } from '../../../../../../../apps/onengo/web/src/app/core/records/record/related';
import { resolveListSpec } from '../../../../../../../apps/onengo/web/src/app/core/records/spec';
import { donationType, donationsView, donationWorkflow, fakeGateway, paramsOf, record } from '../../../../../../../apps/onengo/web/src/app/core/records/gateway/testing';
import { parseListUrl } from '../../../../../../../apps/onengo/web/src/app/core/records/list/url';

const view: ListViewDef = {
  ...donationsView,
  detail: {
    sections: [
      { label: 'Donor', fields: ['donorName', 'amount'] },
      { id: 'instalments', label: 'Instalments', related: { recordType: 'instalment', field: 'donation', total: 'amount' } },
      { label: 'Notes', related: { recordType: 'note', field: 'donation' } },
    ],
  },
};
const spec = resolveListSpec(donationType, donationWorkflow, view);

describe('related sections', () => {
  it('keeps field sections for the detail and lists related sections apart', () => {
    expect(spec.sections).toEqual([{ id: 'section0', label: 'Donor', fields: ['donorName', 'amount'] }]);
    expect(spec.related).toEqual([
      { id: 'instalments', label: 'Instalments', recordType: 'instalment', field: 'donation', total: 'amount' },
      { id: 'section2', label: 'Notes', recordType: 'note', field: 'donation', total: undefined },
    ]);
    expect(resolveListSpec(donationType, donationWorkflow, donationsView).related).toEqual([]);
    expect(rowModel(spec, record()).title).toBe('Asha');
  });

  it('asks for the latest ten pointing at the record, with the total when there is one', () => {
    expect(relatedQuery(spec.related[0]!, 'r1')).toEqual<{ recordType: string; body: RecordQueryBody }>({
      recordType: 'instalment',
      body: { filters: { donation: { in: ['r1'] } }, sort: { field: 'createdAt', dir: 'desc' }, limit: 10, sum: ['amount'] },
    });
    expect(relatedQuery(spec.related[1]!, 'r1').body.sum).toEqual([]);
  });

  it('loads each section with the record; a failing section shows its error and the others still load', async () => {
    const fake = fakeGateway();
    const query = fake.gateway.query;
    fake.gateway.query = async (type, body) => {
      if (type === 'note') throw { code: 'forbidden', message: 'You cannot see notes.' };
      return { ...(await query(type, body)), sums: { amount: 4500 } };
    };
    const s = new RecordSession(fake.gateway, spec, () => ({ id: 'u1', roles: [] }), { saved: () => undefined, failed: () => undefined });
    await s.follow(parseListUrl(paramsOf({ id: 'r1' }), spec));
    expect(fake.calls.filter((c) => c.op === 'query').map((c) => c.args[0])).toEqual(['instalment']);
    expect(s.snapshot.related).toMatchObject([
      { id: 'instalments', count: 41, sum: 4500, error: '' },
      { id: 'section2', count: 0, items: [], error: 'You cannot see notes.' },
    ]);
    expect(s.snapshot.related[0]!.items).toHaveLength(10);
    expect(s.snapshot.related[1]!.sum).toBeUndefined();

    await s.follow(parseListUrl(paramsOf({ create: 'new' }), spec));
    expect(s.snapshot.related).toEqual([]);
  });
});
