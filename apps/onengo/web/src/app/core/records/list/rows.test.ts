import { describe, expect, it } from 'vitest';
import type { RuntimeAction } from '../../models';
import { panelRow, recordRow, rowIntent, rowPanel } from './rows';
import { resolveListSpec } from '../spec';
import { donationType, donationsView, donationWorkflow, record } from '../gateway/testing';

const remind: RuntimeAction = { key: 'remind', recordType: 'donation', label: 'Send reminder', placement: ['row'], steps: [{ type: 'notify' }], allowed: true };
const pay: RuntimeAction = { ...remind, key: 'pay', label: 'Pay now', confirm: 'Create a payment link?' };
const spec = resolveListSpec(donationType, donationWorkflow, donationsView, { actions: [remind, pay] });
const viewer = { id: 'u1', roles: [] };

describe('row menus open the record panel or run an action', () => {
  it('maps menu entries to panel modes, and actions without a form or confirmation to running at once', () => {
    expect(rowPanel(spec, 'edit')).toEqual({ kind: 'edit' });
    expect(rowPanel(spec, 'step:markPaid')).toEqual({ kind: 'step', step: 'markPaid' });
    expect(rowPanel(spec, 'step:')).toBeNull();
    expect(rowPanel(spec, 'action:pay')).toEqual({ kind: 'action', action: 'pay' });
    expect(rowPanel(spec, 'action:remind')).toBeNull();
    expect(rowIntent(spec, 'action:remind')).toEqual({ run: remind });
    expect(rowIntent(spec, 'action:unknown')).toBeNull();
  });

  it('keeps every entry the row can act on, with the configured actions after a divider', () => {
    expect(recordRow(spec, record(), viewer, 'outstanding').actions.map((a) => a.id)).toEqual(['edit', 'step:markPaid', 'action:remind', 'action:pay']);
    expect(panelRow(spec, record(), viewer, 'outstanding')).toEqual({
      ...recordRow(spec, record(), viewer, 'outstanding'),
      actions: [
        { id: 'edit', label: 'Edit' },
        { id: 'step:markPaid', label: 'Mark as paid' },
        { id: 'action:remind', label: 'Send reminder', divider: true },
        { id: 'action:pay', label: 'Pay now' },
      ],
    });
  });
});
