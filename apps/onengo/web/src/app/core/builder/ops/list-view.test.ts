import { describe, expect, it } from 'vitest';
import type { ListViewDef } from '../../models';
import { chipSummary } from '../list-view-view';
import { donationsView, donationType, donorType } from '../../testing/sample-data';
import * as ops from './list-view';

const base = (): ListViewDef => structuredClone(donationsView);

describe('list view operations', () => {
  it('add, rename, switch, order and remove chips, keeping the default and form chips valid', () => {
    let b = ops.addChip(base(), 'Closed for now');
    expect(b.chips!.at(-1)).toEqual({ id: 'closed_for_now', label: 'Closed for now' });
    b = ops.setChipLabel(b, 4, 'Closed');
    expect(b.chips![4]!.id).toBe('closed');
    expect(ops.setChipLabel(b, 4, 'Done', ['closed']).chips![4]).toEqual({ id: 'closed', label: 'Done' });
    b = ops.setChipShows(b, 4, 'statuses');
    b = ops.toggleChipStatus(b, 4, 'paid', true);
    b = ops.toggleChipStatus(b, 4, 'cancelled', true);
    expect(b.chips![4]).toEqual({ id: 'closed', label: 'Closed', statusIn: ['paid', 'cancelled'] });
    b = ops.setChipPermission(b, 4, ' donation:closed:read ');
    expect(b.chips![4]!.permission).toBe('donation:closed:read');
    b = ops.setChipShows(b, 4, 'mine');
    expect(b.chips![4]).toEqual({ id: 'closed', label: 'Closed', permission: 'donation:closed:read', owner: 'me' });
    b = ops.setChipShows(b, 4, 'workflowState', 'thanks');
    b = ops.toggleChipState(b, 4, 'sent', true);
    expect(b.chips![4]!.workflowState).toEqual({ workflow: 'thanks', in: ['sent'] });
    expect(ops.setChipWorkflow(b, 4, 'other').chips![4]!.workflowState).toEqual({ workflow: 'other', in: [] });

    b = ops.setEditChips(ops.setCreateChips(ops.setDefaultChip(b, 'closed'), ['closed', 'mine']), ['closed']);
    b = ops.moveChip(b, 4, 0);
    expect(b.chips!.map((c) => c.id)).toEqual(['closed', 'outstanding', 'paid', 'mine', 'all']);
    b = ops.removeChip(b, 0);
    expect(b.defaultChip).toBeUndefined();
    expect(b.create!.chips).toEqual(['mine']);
    expect(b.edit).toEqual({ fields: ['amount', 'purpose', 'notes'] });
    expect(ops.setDefaultChip(b, 'nope').defaultChip).toBeUndefined();
  });

  it('shows records matching a field value, such as donor type Guest', () => {
    let b = ops.setChipShows(base(), 0, 'field');
    expect(b.chips![0]).toEqual({ id: 'outstanding', label: 'Outstanding', filters: {} });
    expect(ops.chipShows(b.chips![0]!)).toBe('field');
    b = ops.addChipCondition(b, 0, 'donorType');
    b = ops.toggleChipValue(b, 0, 'donorType', 'guest', true);
    expect(b.chips![0]!.filters).toEqual({ donorType: { eq: 'guest' } });
    b = ops.toggleChipValue(b, 0, 'donorType', 'member', true);
    expect(b.chips![0]!.filters).toEqual({ donorType: { in: ['guest', 'member'] } });
    b = ops.toggleChipValue(b, 0, 'donorType', 'guest', false);
    expect(b.chips![0]!.filters!.donorType).toEqual({ eq: 'member' });
    b = ops.addChipCondition(b, 0, 'amount');
    b = ops.setChipBound(b, 0, 'amount', 'from', 1000);
    b = ops.setChipBound(b, 0, 'amount', 'to', null);
    expect(b.chips![0]!.filters!.amount).toEqual({ from: 1000 });
    const type = { key: 'donor', fields: [{ key: 'donorType', label: 'Donor type', type: 'choice' as const, choices: [{ value: 'member', label: 'Member' }] }] };
    expect(chipSummary(b.chips![0]!, [], type)).toBe('Donor type = Member, amount 1000–…');
    b = ops.setChipShows(b, 0, 'all');
    expect(b.chips![0]!.filters).toBeUndefined();
    expect(ops.chipShows(b.chips![0]!)).toBe('all');
  });

  it('caps chips at eight and keeps ids unique', () => {
    let b: ListViewDef = { key: 'x', recordType: 'donation' };
    for (let i = 0; i < 10; i++) b = ops.addChip(b, 'Open');
    expect(b.chips).toHaveLength(8);
    expect(new Set(b.chips!.map((c) => c.id)).size).toBe(8);
    expect(b.chips!.slice(0, 2).map((c) => c.id)).toEqual(['open', 'open2']);
  });

  it('set filters, columns and tablet columns within their limits, and the card row', () => {
    let b = ops.setFieldList(base(), 'compactColumns', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'a']);
    expect(b.compactColumns).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    b = ops.moveInList(ops.addToList(b, 'filters', 'donorName'), 'filters', 5, 0);
    expect(b.filters![0]).toBe('donorName');
    expect('columns' in ops.setFieldList(b, 'columns', [])).toBe(false);
    expect(ops.removeFromList(b, 'filters', 'method').filters).not.toContain('method');
    b = ops.setRow(b, { title: 'donorName', subtitle: [], meta: '', badge: 'status' });
    expect(b.row).toEqual({ title: 'donorName', badge: 'status' });
    expect('row' in ops.setRow(b, { title: '', badge: '' })).toBe(false);
    expect(ops.setPageSize(b, 500).pageSize).toBe(100);
    expect(ops.setPageSize(b, 2).pageSize).toBe(5);
    expect('pageSize' in ops.setPageSize(b, null)).toBe(false);
    expect(ops.setLayout(b, 'table').layout).toBe('table');
  });

  it('offer only filterable, non-sensitive fields as filters and never sensitive columns', () => {
    const type = { fields: [...donationType.fields, { key: 'pan', label: 'PAN', type: 'text' as const, sensitive: true }, { key: 'photo', label: 'Photo', type: 'file' as const }] };
    expect(ops.filterableFields(type).map((f) => f.key)).not.toContain('pan');
    expect(ops.filterableFields(type).map((f) => f.key)).not.toContain('notes');
    expect(ops.filterableFields(type).map((f) => f.key)).not.toContain('photo');
    expect(ops.columnFields(type).map((f) => f.key)).not.toContain('pan');
  });

  it('switch sections between fields and related records, with permission, fields and related choices', () => {
    let b = ops.addSection(base(), 'related', 'Receipts');
    expect(b.detail!.sections[1]).toEqual({ id: 'receipts', label: 'Receipts', related: { recordType: '', field: '' } });
    b = ops.setRelated(b, 1, { recordType: 'donation', field: 'donor', total: 'amount' });
    expect(b.detail!.sections[1]).toMatchObject({ related: { recordType: 'donation', field: 'donor', total: 'amount' } });
    expect(ops.setRelated(b, 1, { recordType: 'gift' }).detail!.sections[1]).toMatchObject({ related: { recordType: 'gift', field: '' } });
    expect(ops.setRelated(b, 1, { total: '' }).detail!.sections[1]).toEqual({ id: 'receipts', label: 'Receipts', related: { recordType: 'donation', field: 'donor' } });
    b = ops.setSectionPermission(b, 1, 'donation:notes:read');
    b = ops.setSectionKind(b, 1, 'fields');
    expect(b.detail!.sections[1]).toEqual({ id: 'receipts', label: 'Receipts', permission: 'donation:notes:read', fields: [] });
    b = ops.setSectionFields(b, 1, ['notes', 'amount', 'notes']);
    b = ops.moveSectionField(b, 1, 1, 0);
    expect(b.detail!.sections[1]).toMatchObject({ fields: ['amount', 'notes'] });
    expect(ops.setSectionPermission(b, 1, '').detail!.sections[1]).not.toHaveProperty('permission');
    b = ops.moveSection(b, 1, 0);
    expect(b.detail!.sections.map((s, i) => ops.sectionId(s, i))).toEqual(['receipts', 'donation']);
    expect(ops.removeSection(ops.removeSection(b, 0), 0)).not.toHaveProperty('detail');
    expect(ops.relatedChoices([donorType, donationType], 'donor')).toEqual([{ recordType: 'donation', label: 'Donation', field: 'donor', fieldLabel: 'Donor' }]);
    expect(ops.totalFields(donationType).map((f) => f.key)).toEqual(['amount']);
  });

  it('turn one page into steps and back, drag fields between steps, and flag required fields on no step', () => {
    let b: ListViewDef = { key: 'donations', recordType: 'donation' };
    expect(ops.missingRequired(b, donationType)).toEqual([]);
    b = ops.setCreateMode(b, 'steps', 'Donor', ['donor', 'amount', 'purpose']);
    expect(b.create).toEqual({ steps: [{ key: 'donor', label: 'Donor', fields: ['donor', 'amount', 'purpose'] }] });
    b = ops.addCreateStep(b, 'Gift details');
    b = ops.placeCreateField(b, 'amount', 1);
    b = ops.placeCreateField(b, 'purpose', 1, 0);
    expect(b.create!.steps!.map((s) => [s.key, s.fields])).toEqual([
      ['donor', ['donor']],
      ['giftDetails', ['purpose', 'amount']],
    ]);
    expect(ops.setCreateStepFields(b, 0, ['donor', 'amount']).create!.steps!.map((s) => s.fields)).toEqual([['donor', 'amount'], ['purpose']]);
    b = ops.setCreateStepLabel(b, 1, 'Gift');
    expect(b.create!.steps![1]!.key).toBe('gift');
    b = ops.removeCreateField(b, 'donor');
    expect(ops.missingRequired(b, donationType).map((f) => f.key)).toEqual(['donor']);
    b = ops.placeCreateField(b, 'donor', 0);
    expect(ops.missingRequired(b, donationType)).toEqual([]);
    b = ops.moveCreateStep(b, 1, 0);
    b = ops.removeCreateStep(b, 0);
    expect(b.create!.steps).toEqual([{ key: 'donor', label: 'Donor', fields: ['donor', 'purpose', 'amount'] }]);
    b = ops.setCreateMode(b, 'page');
    expect(b.create).toEqual({ fields: ['donor', 'purpose', 'amount'] });
    expect(ops.removeCreateStep(ops.setCreateMode(b, 'steps', 'All'), 0).create).toEqual({ fields: ['donor', 'purpose', 'amount'] });
    const copied = { fields: [{ key: 'ref', label: 'Ref', type: 'reference' as const }, { key: 'name', label: 'Name', type: 'text' as const, required: true, copyFrom: { reference: 'ref', field: 'name' } }] };
    expect(ops.missingRequired(ops.setCreatePageFields(b, ['ref']), copied)).toEqual([]);
  });

  it('set the columns and full-width fields of the create and edit forms, and drop a full-width field once it leaves its form', () => {
    let b = ops.setCreatePageFields(base(), ['amount', 'purpose', 'donor']);
    b = ops.setCreateColumns(b, 2);
    b = ops.setCreateFullWidth(b, ['purpose', 'donor', 'purpose']);
    expect(b.create).toMatchObject({ columns: 2, fullWidth: ['purpose', 'donor'] });
    b = ops.placeCreateField(ops.setCreateMode(b, 'steps', 'All'), 'donor', 0, 0);
    expect(b.create!.fullWidth).toEqual(['purpose', 'donor']);
    b = ops.setCreatePageFields(b, ['purpose', 'amount']);
    expect(b.create).toEqual({ fields: ['purpose', 'amount'], columns: 2, fullWidth: ['purpose'] });
    b = ops.removeCreateField(b, 'purpose');
    expect(b.create).toEqual({ fields: ['amount'], columns: 2 });
    expect(ops.setCreateColumns(b, 1).create).toEqual({ fields: ['amount'] });

    let e = ops.setEditFullWidth(ops.setEditColumns({ key: 'donations', recordType: 'donation' }, 3), ['amount']);
    expect(e.edit).toEqual({ columns: 3, fullWidth: ['amount'] });
    e = ops.setEditFields(e, ['notes']);
    expect(e.edit).toEqual({ fields: ['notes'], columns: 3 });
    expect(ops.setEditFullWidth(e, []).edit).toEqual({ fields: ['notes'], columns: 3 });
    expect(ops.setEditColumns(e, 1).edit).toEqual({ fields: ['notes'] });
  });

  it('keep presets, offered chips and edit fields tidy', () => {
    let b = ops.addPreset(base(), 'donor', 'donor');
    b = ops.addPreset(b, 'donor', 'donorName');
    expect(b.create!.presets).toEqual([{ param: 'donor', field: 'donorName' }]);
    b = ops.removePreset(b, 0);
    expect(b.create).not.toHaveProperty('presets');
    expect(ops.setEditFields(b, []).edit).toBeUndefined();
    expect(ops.setEditFields(b, ['notes', 'notes']).edit).toEqual({ fields: ['notes'] });
  });

  it('turn the index manager warnings into notices for the draft filters and columns', () => {
    const b = { ...base(), filters: ['method', 'amount'], columns: ['number', 'amount', 'purpose'] };
    expect(ops.indexNotices(b, { pending: ['amount', 'donor'], notIndexed: ['purpose'] })).toEqual([
      { field: 'amount', kind: 'pending' },
      { field: 'purpose', kind: 'notIndexed' },
    ]);
  });
});
