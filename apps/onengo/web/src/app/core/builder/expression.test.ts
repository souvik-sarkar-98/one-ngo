import { describe, expect, it } from 'vitest';
import { EXPRESSION_FUNCTIONS } from '../server';
import english from '@onengo/product/locale/en.builder.json';
import type { RecordTypeBody, RecordView } from '../models';
import { memoryGateway } from '../testing/memory-gateway';
import type { Timers } from './draft-session';
import { expressionAssist } from './expression-assist';
import {
  applySuggestion,
  closest,
  errorSpan,
  expressionCatalogue,
  FUNCTION_NAMES,
  functionArgs,
  insertEntry,
  localCheck,
  recordLabel,
  replaceWordAt,
  resultText,
  sampleFromRecord,
  sampleScope,
  sampleSlots,
  suggest,
  type CatalogueEntry,
  type ExpressionSubject,
} from './expression-catalogue';
import { ExpressionSession } from './expression-session';

const donation: RecordTypeBody = {
  key: 'donation',
  label: 'Donation',
  titleField: 'donorName',
  fields: [
    { key: 'donorName', label: 'Donor name', type: 'text' },
    { key: 'amount', label: 'Amount', type: 'money' },
    { key: 'fee', label: 'Fee', type: 'number' },
    { key: 'donorPan', label: 'Tax number', type: 'text' },
    { key: 'paidOn', label: 'Paid on', type: 'date' },
    { key: 'anonymous', label: 'Anonymous', type: 'boolean' },
  ],
};
const subject: ExpressionSubject = { recordType: donation, workflows: ['donation', 'kyc'] };
const names = (es: CatalogueEntry[]) => es.map((e) => e.name);
const entry = (name: string, es = expressionCatalogue(subject)) => es.find((e) => e.name === name)!;

describe('expression catalogue', () => {
  it('lists fields, previous values, status, workflow states, the person and functions', () => {
    const c = expressionCatalogue(subject);
    expect(names(c.filter((e) => e.kind === 'field'))).toEqual(['record.donorName', 'record.amount', 'record.fee', 'record.donorPan', 'record.paidOn', 'record.anonymous', 'record.id', 'record.number']);
    expect(names(c.filter((e) => e.kind === 'previous'))).toEqual(donation.fields.map((f) => `previous.${f.key}`));
    expect(names(c.filter((e) => e.kind === 'status'))).toEqual(['status', 'previousStatus', 'workflow']);
    expect(names(c.filter((e) => e.kind === 'state'))).toEqual(['states.donation', 'states.kyc']);
    expect(names(c.filter((e) => e.kind === 'person'))).toEqual(['user.id', 'user.roles']);
    expect(names(c.filter((e) => e.kind === 'function'))).toEqual([...EXPRESSION_FUNCTIONS]);
    expect(entry('record.amount', c)).toMatchObject({ valueType: 'number', label: 'Amount' });
    expect(entry('previous.amount', c).note).toEqual({ key: 'ui.expression.notes.previous', params: { label: 'Amount' } });
    expect(entry('states.kyc', c).note).toEqual({ key: 'ui.expression.notes.state', params: { workflow: 'kyc' } });
    expect(entry('round', c)).toMatchObject({ code: 'round(x, 2)', valueType: 'number' });
    expect(entry('today', c)).toMatchObject({ code: 'today()', valueType: 'date' });
  });

  it('offers only the names the context can read', () => {
    const automation = expressionCatalogue(subject, 'automation');
    expect(names(automation.filter((e) => e.kind !== 'function' && e.kind !== 'field'))).toEqual(['status', 'previousStatus']);
    const action = expressionCatalogue(subject, 'action', ['reason']);
    expect(names(action)).toContain('input.reason');
    expect(names(expressionCatalogue(subject))).not.toContain('input.reason');
    expect(names(expressionCatalogue({ recordType: null, workflows: [] }).filter((e) => e.kind === 'field'))).toEqual(['record.id', 'record.number']);
  });

  it('describes every function the server evaluator has', () => {
    expect(FUNCTION_NAMES).toEqual(EXPRESSION_FUNCTIONS);
    const en = english as Record<string, string>;
    expect(FUNCTION_NAMES.filter((n) => functionArgs(n) === undefined || !en[`ui.expression.fn.${n}`])).toEqual([]);
    const notes = expressionCatalogue(subject, 'action', ['reason']).flatMap((e) => (e.note ? [e.note.key] : []));
    expect(notes.filter((k) => !en[k])).toEqual([]);
  });
});

describe('expression suggestions', () => {
  const c = expressionCatalogue(subject);
  const at = (text: string, opts?: { explicit?: boolean }) => suggest(text.replace('|', ''), text.indexOf('|'), c, opts);

  it('suggests names starting with the word, then by last part, then by label', () => {
    expect(names(at('record.am|')!.items)).toEqual(['record.amount']);
    expect(at('record.am| > 0')).toMatchObject({ from: 0, to: 9, word: 'record.am' });
    expect(names(at('1 + amo|')!.items)).toEqual(['record.amount', 'previous.amount']);
    expect(names(at('tax|')!.items)).toEqual(['record.donorPan', 'previous.donorPan']);
    expect(names(at('stat|')!.items)).toEqual(['status', 'states.donation', 'states.kyc', 'previousStatus']);
    expect(names(at('rou|')!.items)).toEqual(['round']);
    expect(names(at('record.|')!.items).slice(0, 3)).toEqual(['record.donorName', 'record.amount', 'record.fee']);
  });

  it('stays quiet in texts, numbers, finished names and empty space unless asked', () => {
    expect(at("status == 'pa|")).toBeNull();
    expect(at('12|')).toBeNull();
    expect(at('record.fee|')).toBeNull();
    expect(at('a + |')).toBeNull();
    expect(at('a + |', { explicit: true })!.items).toHaveLength(8);
  });

  it('writes the chosen entry; functions get brackets with the cursor inside', () => {
    const s = at('rec.x + rou|(2)')!;
    expect(applySuggestion('rec.x + rou(2)', s, entry('round'))).toEqual({ source: 'rec.x + round(2)', cursor: 13 });
    expect(applySuggestion('isE', { from: 0, to: 3 }, entry('isEmpty'))).toEqual({ source: 'isEmpty()', cursor: 8 });
    expect(applySuggestion('tod', { from: 0, to: 3 }, entry('today'))).toEqual({ source: 'today()', cursor: 7 });
    expect(applySuggestion('record.am > 0', { from: 0, to: 9 }, entry('record.amount'))).toEqual({ source: 'record.amount > 0', cursor: 13 });
  });

  it('inserts from the buttons at the cursor, completing a half-typed name', () => {
    expect(insertEntry('', 0, entry('record.fee'))).toEqual({ source: 'record.fee', cursor: 10 });
    expect(insertEntry('record.amount - ', 16, entry('record.fee'))).toEqual({ source: 'record.amount - record.fee', cursor: 26 });
    expect(insertEntry('record.amount', 13, entry('record.fee'))).toEqual({ source: 'record.amount record.fee', cursor: 24 });
    expect(insertEntry('record.f', 8, entry('record.fee'))).toEqual({ source: 'record.fee', cursor: 10 });
    expect(insertEntry('1 + ', 99, entry('round'))).toEqual({ source: '1 + round()', cursor: 10 });
  });
});

describe('expression check and did you mean', () => {
  it('finds the likely name like the server does', () => {
    expect(closest('amout', ['donorName', 'amount', 'fee'])).toBe('amount');
    expect(closest('recrd', ['record', 'status'])).toBe('record');
    expect(closest('zzzzzz', ['amount'])).toBeUndefined();
    expect(replaceWordAt('record.amout > 10', 7, 'amount')).toEqual({ source: 'record.amount > 10', cursor: 13 });
    expect(replaceWordAt('1 + 2', 2, 'x')).toBeNull();
  });

  it('checks names per record type and context with the shared parser', () => {
    expect(localCheck('record.amount - coalesce(record.fee, 0)', subject)).toEqual({ ok: true, resultType: 'number' });
    expect(localCheck("status == 'paid' and not isEmpty(record.donorName)", subject)).toEqual({ ok: true, resultType: 'boolean' });
    expect(localCheck('record.amout > 10', subject)).toEqual({ ok: false, error: "Donation has no field 'amout'. Did you mean 'amount'?", position: 7, suggestion: 'amount' });
    expect(localCheck('recrd.amount', subject)).toMatchObject({ ok: false, suggestion: 'record', position: 0 });
    expect(localCheck("states.kyx == 'done'", subject)).toMatchObject({ ok: false, suggestion: 'kyc', position: 7 });
    expect(localCheck('user.role', subject)).toMatchObject({ ok: false, suggestion: 'roles' });
    expect(localCheck('record.amount +', subject)).toEqual({ ok: false, error: "Unexpected '' at 15", position: 15 });
    expect(localCheck('input.reason', subject).ok).toBe(false);
    expect(localCheck('input.reason', subject, 'action', ['reason']).ok).toBe(true);
    expect(localCheck('previous.amount', subject, 'automation')).toMatchObject({ ok: false, error: "Unknown name 'previous'." });
  });

  it('points at the problem in the text', () => {
    expect(errorSpan('record.amout > 10', 7)).toEqual({ before: 'record.', at: 'amout', after: ' > 10' });
    expect(errorSpan('1 + #', 4)).toEqual({ before: '1 + ', at: '#', after: '' });
    expect(errorSpan('record.amount +', 15)).toEqual({ before: 'record.amount +', at: ' ', after: '' });
  });
});

describe('Try it values', () => {
  const record: RecordView = {
    id: 'r1',
    type: 'donation',
    number: 'DON/2026-27/00040',
    status: 'paid',
    version: 3,
    schemaVersion: 1,
    data: { donorName: 'Ravi Kumar', amount: 5000, fee: 50, anonymous: false },
    workflow: 'donation',
    states: { kyc: 'done' },
    createdAt: '',
    updatedAt: '',
  };

  it('asks for the values the expression reads, typed by field', () => {
    const slots = sampleSlots("record.amount - record.fee > 0 and status == 'paid' and states.kyc == 'done' and user.id != '' and record.anonymous and record.amount > 1", subject)!;
    expect(slots).toEqual([
      { path: 'record.amount', input: 'number', label: 'Amount' },
      { path: 'record.fee', input: 'number', label: 'Fee' },
      { path: 'status', input: 'text' },
      { path: 'states.kyc', input: 'text' },
      { path: 'record.anonymous', input: 'boolean', label: 'Anonymous' },
    ]);
    expect(sampleSlots('record.amount +', subject)).toBeNull();
  });

  it('turns entered values into sample scope and reads them from a real record', () => {
    const slots = sampleSlots('record.amount - record.fee + previous.amount and status and states.kyc and record.anonymous and record.number and record.extra', subject)!;
    expect(slots.at(-1)).toEqual({ path: 'record.extra', input: 'text', free: true });
    const values = { 'record.amount': '5000', 'record.fee': 'x', 'previous.amount': '', status: 'paid', 'states.kyc': 'done', 'record.anonymous': 'true', 'record.number': '12', 'record.extra': '7' };
    expect(sampleScope(slots, values)).toEqual({
      record: { amount: 5000, fee: 'x', anonymous: true, number: '12', extra: 7 },
      status: 'paid',
      states: { kyc: 'done' },
    });
    expect(sampleFromRecord(slots, record)).toEqual({
      'record.amount': '5000',
      'record.fee': '50',
      'previous.amount': '',
      status: 'paid',
      'states.kyc': 'done',
      'record.anonymous': 'false',
      'record.number': 'DON/2026-27/00040',
      'record.extra': '',
    });
    expect(recordLabel(donation, record)).toBe('DON/2026-27/00040 · Ravi Kumar');
    expect(resultText(4950)).toBe('4950');
    expect(resultText('Hi')).toBe("'Hi'");
    expect(resultText(null)).toBe('null');
  });
});

describe('expression session with the memory gateway', () => {
  const manualTimers = () => {
    const pending = new Map<number, () => void>();
    let n = 0;
    const timers: Timers = {
      set: (fn) => (pending.set(++n, fn), n),
      clear: (h) => void pending.delete(h as number),
    };
    const flush = () => {
      const fns = [...pending.values()];
      pending.clear();
      fns.forEach((f) => f());
    };
    return { timers, flush, count: () => pending.size };
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const open = (source = '', context: 'record' | 'action' = 'record') => {
    const g = memoryGateway();
    const t = manualTimers();
    const session = new ExpressionSession(expressionAssist(g.builder, g.records), { recordType: 'donation', context }, source, 400, t.timers);
    return { g, t, session };
  };

  it('suggests from the published record type and its workflows', async () => {
    const { session } = open();
    await settle();
    expect(session.snapshot.subject.recordType?.key).toBe('donation');
    expect(names(session.snapshot.catalogue)).toEqual(expect.arrayContaining(['record.amount', 'states.donation', 'user.roles', 'round']));
    session.input('record.amo', 10);
    expect(names(session.snapshot.suggestions!.items)).toEqual(['record.amount']);
    expect(session.key('Enter')).toBe(true);
    expect(session.snapshot).toMatchObject({ source: 'record.amount', cursor: 13, jump: 1, suggestions: null });
  });

  it('checks after typing stops, drops older answers, and takes the did-you-mean', async () => {
    const { g, t, session } = open();
    await settle();
    session.input('record.amout > 1', 16);
    session.input('record.amout > 10', 17);
    expect(session.snapshot.checkState).toBe('checking');
    expect(t.count()).toBe(1);
    t.flush();
    await settle();
    expect(g.calls.filter((c) => c.op === 'checkExpression')).toHaveLength(1);
    expect(session.snapshot).toMatchObject({ checkState: 'error', check: { position: 7, suggestion: 'amount' } });
    session.fix();
    expect(session.snapshot.source).toBe('record.amount > 10');
    t.flush();
    await settle();
    expect(session.snapshot).toMatchObject({ checkState: 'ok', check: { ok: true, resultType: 'boolean' } });
    session.input('', 0);
    expect(session.snapshot.checkState).toBe('empty');
  });

  it('tries on sample values and on a real record', async () => {
    const { g, session } = open('record.amount - coalesce(record.fee, 0)');
    await settle();
    expect(session.snapshot.slots.map((s) => s.path)).toEqual(['record.amount', 'record.fee']);
    session.setSample('record.amount', '5000');
    session.setSample('record.fee', '50');
    await session.tryIt();
    expect(session.snapshot.tried).toEqual({ ok: true, value: 4950, resultType: 'number' });

    const [found] = await session.recordSource.search('');
    session.pickRecord(found!.id);
    const real = g.record(found!.id)!;
    expect(session.snapshot.record?.id).toBe(found!.id);
    expect(session.snapshot.sample['record.amount']).toBe(String(real.data['amount']));
    await session.tryIt();
    expect(session.snapshot.tried).toMatchObject({ ok: true, value: Number(real.data['amount']) });
    expect(g.calls.filter((c) => c.op === 'tryExpression').at(-1)!.args[0]).toMatchObject({ recordId: found!.id });
    session.setSample('record.amount', '1');
    expect(session.snapshot.record).toBeNull();
  });

  it('reports evaluation errors from Try it', async () => {
    const { session } = open('record.amount / 0');
    await settle();
    session.setSample('record.amount', '1');
    await session.tryIt();
    expect(session.snapshot.tried).toMatchObject({ ok: false, error: 'Division by zero' });
  });
});
