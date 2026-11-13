import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkExpression, compileExpression } from '../src/runtime/expressions/expression.js';
import { dateIn, ORGANISATION_TIME_ZONE, organisationToday } from '../src/shared/time/organisation-time.js';

const run = (src: string, scope: Record<string, unknown> = {}) => compileExpression(src).evaluate(scope);

describe('expression language', () => {
  it('evaluates arithmetic, comparison, logic and ternary', () => {
    expect(run('1 + 2 * 3')).toBe(7);
    expect(run('(1 + 2) * 3')).toBe(9);
    expect(run('10 % 4')).toBe(2);
    expect(run('-record.a + 1', { record: { a: 5 } })).toBe(-4);
    expect(run("record.method == 'cash' ? 'CASH' : 'BANK'", { record: { method: 'upi' } })).toBe('BANK');
    expect(run('a > 1 and not b', { a: 2, b: false })).toBe(true);
    expect(run('a > 1 || b', { a: 0, b: 'x' })).toBe(true);
    expect(run("'Donation ' + n", { n: 'DON/1' })).toBe('Donation DON/1');
  });

  it('treats missing fields as null', () => {
    expect(run('record.missing', { record: {} })).toBeNull();
    expect(run('record.missing == null', { record: {} })).toBe(true);
    expect(run('coalesce(record.fee, 0)', { record: {} })).toBe(0);
    expect(run('record.x.y.z', {})).toBeNull();
  });

  it('supports whitelisted functions only', () => {
    expect(run("len('abc')")).toBe(3);
    expect(run('round(2.345, 2)')).toBe(2.35);
    expect(run("isEmpty('')")).toBe(true);
    expect(run("addDays('2026-03-30', 3)")).toBe('2026-04-02');
    expect(run('sum(rows, "amount")', { rows: [{ amount: 10 }, { amount: 2.5 }] })).toBe(12.5);
    expect(run('avg(rows, "amount")', { rows: [{ amount: 10 }, { amount: 20 }] })).toBe(15);
    expect(run('count(rows)', { rows: [1, 2, 3] })).toBe(3);
    expect(run('formatMoney(1234567.5)')).toBe('12,34,567.50');
    expect(run("formatDate('2026-11-05')")).toBe('5 Nov 2026');
    expect(run('inWords(1234567.5)')).toBe('twelve lakh thirty four thousand five hundred sixty seven and fifty paise');
    expect(run("daysBetween('2026-04-01', '2026-04-11')")).toBe(10);
    expect(checkExpression('eval(1)')).toMatch(/Unknown function/);
    expect(checkExpression('record.toString()')).not.toBeNull();
  });

  it('cannot reach prototypes, constructors, or methods', () => {
    expect(checkExpression('record.__proto__')).toMatch(/not allowed/);
    expect(checkExpression('record.constructor')).toMatch(/not allowed/);
    expect(checkExpression('x.prototype')).toMatch(/not allowed/);
    class Hidden {
      secret = 'no';
    }
    expect(run('obj.secret', { obj: new Hidden() })).toBeNull();
    expect(run('arr.length', { arr: [1, 2] })).toBeNull();
    expect(run('len(arr)', { arr: [1, 2] })).toBe(2);
  });

  it('rejects malformed or abusive input', () => {
    expect(checkExpression('1 +')).not.toBeNull();
    expect(checkExpression("'open")).toMatch(/Unterminated/);
    expect(checkExpression('a ; b')).toMatch(/Unexpected character/);
    expect(checkExpression('('.repeat(200) + '1' + ')'.repeat(200))).toMatch(/nested too deeply/);
    expect(checkExpression('1+'.repeat(1500) + '1')).toMatch(/too long/);
    expect(() => run('1 / 0')).toThrow(/Division by zero/);
    expect(() => run("1 < 'a'")).toThrow(/Cannot compare/);
  });
});

describe("the organisation's day", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 01:00 on 4 November in Kolkata, when UTC is still 3 November. */
  const justAfterMidnight = new Date('2026-11-03T19:30:00Z');

  it('reads the day in the time zone, not in UTC', () => {
    expect(ORGANISATION_TIME_ZONE).toBe('Asia/Kolkata');
    expect(dateIn('Asia/Kolkata', justAfterMidnight)).toBe('2026-11-04');
    expect(dateIn('UTC', justAfterMidnight)).toBe('2026-11-03');
    expect(organisationToday(justAfterMidnight)).toBe('2026-11-04');
  });

  it('takes today from the clock in the organisation time zone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(justAfterMidnight);
    expect(run('today()')).toBe('2026-11-04');
  });

  it('accepts a payment dated today just after midnight in India, and refuses tomorrow', () => {
    vi.useFakeTimers();
    vi.setSystemTime(justAfterMidnight);
    const guard = 'record.paidOn <= today()';
    expect(run(guard, { record: { paidOn: '2026-11-04' } })).toBe(true);
    expect(run(guard, { record: { paidOn: '2026-11-03' } })).toBe(true);
    expect(run(guard, { record: { paidOn: '2026-11-05' } })).toBe(false);
  });
});
