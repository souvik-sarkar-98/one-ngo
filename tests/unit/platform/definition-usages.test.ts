import { describe, expect, it } from 'vitest';
import { findUsages, type AnyDefinition } from '../../../packages/platform/src/runtime/definitions/usages.js';

// Minimal bodies: only the parts the usage rules read.
const def = (kind: string, key: string, body: Record<string, unknown>) => ({ kind, key, body }) as unknown as AnyDefinition;

const notifyAutomation = def('automation', 'chase', { actions: [{ type: 'notify', template: 'reminder', to: {} }] });
const openReportAction = def('action', 'show-report', { steps: [{ type: 'report', report: 'gifts' }] });
const printedReport = def('report', 'receipts', { outputs: { pdf: { template: 'letter' } } });
const reportGroup = def('reportGroup', 'finance', { reports: ['gifts', 'other'] });
const linkingPage = def('page', 'hub', {
  widgets: [
    { type: 'links', label: 'Go', items: [{ label: 'Gifts', to: '/reports/gifts?year=2026' }, { label: 'Home', to: '/' }] },
    { type: 'stat', label: 'Count' },
  ],
});

describe('what uses a template, a report or a list', () => {
  it('finds a template sent by an automation, and one a report prints', () => {
    expect(findUsages([notifyAutomation], { kind: 'template', key: 'reminder' })).toEqual([
      expect.objectContaining({ kind: 'automation', key: 'chase', path: '/actions/0/template', what: 'sends it' }),
    ]);
    expect(findUsages([printedReport], { kind: 'template', key: 'letter' })).toEqual([
      expect.objectContaining({ kind: 'report', key: 'receipts', path: '/outputs/pdf/template', what: 'prints it' }),
    ]);
    expect(findUsages([notifyAutomation, printedReport], { kind: 'template', key: 'unused' })).toEqual([]);
  });

  it('finds a report a group lists, an action opens, and a page links to', () => {
    expect(findUsages([reportGroup], { kind: 'report', key: 'gifts' })).toEqual([
      expect.objectContaining({ kind: 'reportGroup', path: '/reports/0', what: 'report group' }),
    ]);
    expect(findUsages([openReportAction], { kind: 'report', key: 'gifts' })).toEqual([
      expect.objectContaining({ kind: 'action', key: 'show-report', path: '/steps/0/report', what: 'opens it' }),
    ]);
    expect(findUsages([linkingPage], { kind: 'report', key: 'gifts' })).toEqual([
      expect.objectContaining({ kind: 'page', key: 'hub', path: '/widgets/0/items/0/to', what: "link 'Gifts'" }),
    ]);
    expect(findUsages([linkingPage], { kind: 'report', key: 'gift' })).toEqual([]);
  });
});
