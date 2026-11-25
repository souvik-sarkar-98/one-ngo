import { describe, expect, it } from 'vitest';
import { isTypeHidden, offeredWorkflows, shownRecordTypes } from './hidden';
import type { ModuleDefinition } from './builder/http-access';
import { behindTheScenes, definitionName, hiddenCount, visibilityGroups } from './builder/module-visibility';
import { startingLayout } from './admin/layout-draft';
import { approvalFilters } from './inbox/rows';
import { memoryGateway } from './testing/memory-gateway';
import type { RuntimeDefinitions, RuntimeRecordType, RuntimeWorkflow } from './models';
import type { InboxAddress } from './inbox/address';

const address: InboxAddress = { q: '', type: [], step: [], requestedBy: [], show: 0 };
const definitions = (): Promise<RuntimeDefinitions> => memoryGateway().auth.definitions();

const withHidden = (defs: RuntimeDefinitions, key: string): RuntimeDefinitions => ({
  ...defs,
  recordTypes: defs.recordTypes.map((t): RuntimeRecordType => (t.key === key ? { ...t, hidden: true } : t)),
});

describe('hidden record types', () => {
  it('are left out of what menus and choosers offer, but can still be found by key', async () => {
    const defs = await definitions();
    const first = defs.recordTypes[0]!.key;
    expect(shownRecordTypes(defs).map((t) => t.key)).toContain(first);

    const hidden = withHidden(defs, first);
    expect(shownRecordTypes(hidden).map((t) => t.key)).not.toContain(first);
    expect(shownRecordTypes(hidden)).toHaveLength(defs.recordTypes.length - 1);
    expect(isTypeHidden(hidden, first)).toBe(true);
    expect(isTypeHidden(hidden, 'nothing')).toBe(false);
    expect(hidden.recordTypes.map((t) => t.key)).toContain(first);
  });

  it('cope with no definitions yet', () => {
    expect(shownRecordTypes(null)).toEqual([]);
    expect(shownRecordTypes(undefined)).toEqual([]);
    expect(isTypeHidden(null, 'x')).toBe(false);
  });

  it('are not offered as a starting navigation item', async () => {
    const defs = await definitions();
    const first = defs.recordTypes[0]!.key;
    const navigation = { items: ['home', `record:${first}`] };
    expect(startingLayout(null, { ...defs, navigation }).items).toContain(`record:${first}`);
    expect(startingLayout(null, { ...withHidden(defs, first), navigation }).items).not.toContain(`record:${first}`);
  });
});

describe('hidden workflows', () => {
  const flow = (key: string, hidden?: boolean): RuntimeWorkflow =>
    ({ key, recordType: 'donation', initial: 'a', states: [], transitions: [], ...(hidden ? { hidden } : {}) }) as unknown as RuntimeWorkflow;

  it('are not offered, while the others are', () => {
    expect(offeredWorkflows([flow('one'), flow('two', true), flow('three')]).map((w) => w.key)).toEqual(['one', 'three']);
  });

  it('add no approval filters for a hidden record type or a hidden workflow', async () => {
    const defs = await definitions();
    const withApproval = (hide: (d: RuntimeDefinitions, type: string) => RuntimeDefinitions) => {
      const base = defs;
      const type = Object.keys(base.workflowSets ?? base.workflows)[0]!;
      const set = (base.workflowSets?.[type] ?? [base.workflows[type]!]).map((w) => ({
        ...w,
        transitions: w.transitions.map((t, i) => (i === 0 ? { ...t, approval: { required: 1 } } : t)),
      })) as RuntimeWorkflow[];
      const prepared = { ...base, workflowSets: { ...(base.workflowSets ?? {}), [type]: set } } as RuntimeDefinitions;
      return { type, defs: hide(prepared, type) };
    };
    const typeOptions = (d: RuntimeDefinitions) => approvalFilters(d, new Map(), address).find((f) => f.key === 'type')!.options.map((o) => o.key);

    const shown = withApproval((d) => d);
    expect(typeOptions(shown.defs)).toContain(shown.type);

    const hiddenType = withApproval((d, type) => withHidden(d, type));
    expect(typeOptions(hiddenType.defs)).not.toContain(hiddenType.type);

    const hiddenFlow = withApproval((d, type) => ({ ...d, workflowSets: { ...d.workflowSets, [type]: d.workflowSets![type]!.map((w) => ({ ...w, hidden: true })) } }));
    expect(typeOptions(hiddenFlow.defs)).not.toContain(hiddenFlow.type);
  });
});

describe('what the Modules screen shows for a module', () => {
  const def = (kind: ModuleDefinition['kind'], key: string, extra: Partial<ModuleDefinition> = {}): ModuleDefinition => ({
    kind,
    key,
    label: null,
    hidden: false,
    hideable: !['template', 'automation', 'script', 'postingRule', 'receiptRule'].includes(kind),
    blocked: null,
    ...extra,
  });
  const defs = [
    def('listView', 'meetings'),
    def('recordType', 'meeting', { label: 'Meetings' }),
    def('recordType', 'resolution', { label: 'Resolutions', hidden: true }),
    def('template', 'notice'),
    def('workflow', 'meetingStatus'),
  ];

  it('counts what is hidden, and nothing for definitions people never see', () => {
    expect(hiddenCount(defs)).toBe(1);
    expect(hiddenCount([def('template', 'x', { hidden: true })])).toBe(0);
    expect(hiddenCount([])).toBe(0);
  });

  it('groups what people see by kind in a fixed order, and lists the rest behind the scenes', () => {
    expect(visibilityGroups(defs).map((g) => g.kind)).toEqual(['recordType', 'listView', 'workflow']);
    expect(visibilityGroups(defs)[0]!.items.map((d) => d.key)).toEqual(['meeting', 'resolution']);
    expect(behindTheScenes(defs).map((d) => d.key)).toEqual(['notice']);
  });

  it('names a definition by its label, else its key', () => {
    expect(definitionName({ label: 'Meetings', key: 'meeting' })).toBe('Meetings');
    expect(definitionName({ label: null, key: 'meetingStatus' })).toBe('meetingStatus');
  });
});
