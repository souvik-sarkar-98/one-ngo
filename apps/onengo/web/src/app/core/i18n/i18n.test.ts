import { afterEach, describe, expect, it } from 'vitest';
import { addText, ENGLISH, flattenMessages, formatDate, formatMoney, formatNumber, intlLocale, loadText, lowerLabel, t, translator, useMessages } from './i18n';

afterEach(() => {
  useMessages('en', ENGLISH);
});

describe('screen text', () => {
  it('looks keys up, fills placeholders, and leaves unknown placeholders alone', () => {
    const en = translator('en', ENGLISH);
    expect(en.t('ui.common.save')).toBe('Save');
    expect(en.t('ui.home.welcome', { name: 'Asha' })).toBe('Welcome, Asha');
    expect(en.t('ui.records.approvalSummary', { step: 'Cancel', by: 'Vikram', given: 0, needed: 1 })).toBe(
      'Waiting for approval to "Cancel" — requested by Vikram, 0 of 1 approvals.',
    );
    expect(en.t('ui.builder.recordType.numberTokens')).toBe('Tokens: {fy} financial year, {seq:5} running number');
    expect(en.t('ui.builder.starter.subject')).toBe('Update on {{ record.number }}');
  });

  it('lowers a label inside a sentence but keeps one that opens with capitals', () => {
    expect(lowerLabel('Donation')).toBe('donation');
    expect(lowerLabel('QA field check')).toBe('QA field check');
    expect(lowerLabel('API key')).toBe('API key');
    expect(lowerLabel('')).toBe('');
  });

  it('chooses key.one or key.other by the locale plural rule and writes counts in Indian grouping', () => {
    const en = translator('en', ENGLISH);
    expect(en.t('ui.records.count', { count: 1 })).toBe('1 record');
    expect(en.t('ui.records.count', { count: 0 })).toBe('0 records');
    expect(en.t('ui.records.count', { count: 100000 })).toBe('1,00,000 records');
    expect(en.t('ui.records.countOf', { shown: 20, count: 1500 })).toBe('Showing 20 of 1,500 records');

    const hi = translator('hi', { 'ui.test.files.one': 'ONE {count}', 'ui.test.files.other': 'OTHER {count}' }, {});
    expect(hi.t('ui.test.files', { count: 0 })).toBe('ONE 0');
    expect(hi.t('ui.test.files', { count: 1 })).toBe('ONE 1');
    expect(hi.t('ui.test.files', { count: 2 })).toBe('OTHER 2');
    expect(translator('en', { 'ui.test.files.other': 'only other' }, {}).t('ui.test.files', { count: 1 })).toBe('only other');
    expect(translator('en', { 'ui.test.plain': 'plain' }, {}).t('ui.test.plain', { count: 3 })).toBe('plain');
  });

  it('falls back to English for missing or empty entries, then to the key', () => {
    const ta = translator('ta', { 'ui.common.save': 'TA-save', 'ui.common.cancel': '' });
    expect(ta.t('ui.common.save')).toBe('TA-save');
    expect(ta.t('ui.common.cancel')).toBe('Cancel');
    expect(ta.t('ui.records.count', { count: 2 })).toBe('2 records');
    expect(ta.t('ui.no.such.key')).toBe('ui.no.such.key');
    expect(ta.has('ui.records.count')).toBe(true);
    expect(ta.has('ui.no.such.key')).toBe(false);
  });

  it('a translated other form wins over the English one form', () => {
    const mr = translator('mr', { 'ui.records.count.other': 'MR {count}' });
    expect(mr.t('ui.records.count', { count: 1 })).toBe('MR 1');
  });

  it('accepts flat and nested catalogues alike, as the server does', () => {
    expect(flattenMessages({ ui: { nav: { home: 'Home' }, empty: '' }, 'ui.flat': 'Flat' })).toEqual({ 'ui.nav.home': 'Home', 'ui.flat': 'Flat' });
  });

  it('switches the shared text for the whole app', () => {
    expect(t('ui.common.edit')).toBe('Edit');
    useMessages('hi', { ...ENGLISH, 'ui.common.edit': 'HI-edit' });
    expect(t('ui.common.edit')).toBe('HI-edit');
    expect(t('ui.common.save')).toBe('Save');
  });

  it('adds shipped text for the language in use without replacing the organisation wording', () => {
    useMessages('hi', { 'ui.common.edit': 'ORG-edit' });
    addText('hi', { 'ui.common.edit': 'HI-edit', 'ui.common.save': 'HI-save' });
    addText('ta', { 'ui.common.cancel': 'TA-cancel' });
    expect([t('ui.common.edit'), t('ui.common.save'), t('ui.common.cancel')]).toEqual(['ORG-edit', 'HI-save', 'Cancel']);
    expect(ENGLISH['ui.common.save']).toBe('Save');
  });

  it('replaces an English echo with the shipped translation', () => {
    useMessages('hi', { 'ui.nav.settings': ENGLISH['ui.nav.settings'] ?? 'Settings', 'ui.common.edit': 'ORG-edit' });
    addText('hi', { 'ui.nav.settings': 'सेटिंग्स', 'ui.common.edit': 'HI-edit' });
    expect(t('ui.nav.settings')).toBe('सेटिंग्स');
    expect(t('ui.common.edit')).toBe('ORG-edit');
  });

  it('loads an area of text once, in English and the language in use', async () => {
    const builder = flattenMessages((await import('@onengo/product/locale/en.builder.json')).default);
    const hindi = flattenMessages((await import('@onengo/product/locale/hi.builder.json')).default);
    const key = 'ui.builder.recordType.numberTokens';
    useMessages('en', {});
    delete ENGLISH[key];
    expect(t(key)).toBe(key);
    await loadText('builder');
    expect(t(key)).toBe(builder[key]);
    useMessages('hi', {});
    await expect(loadText('builder')).resolves.toBeUndefined();
    expect(t(key)).toBe(hindi[key]);
  });
});

describe('number, money and date formats per locale', () => {
  it('uses Indian conventions with Latin digits', () => {
    expect(intlLocale('en')).toBe('en-IN-u-nu-latn');
    expect(intlLocale('hi')).toBe('hi-IN-u-nu-latn');
    expect(intlLocale('en-GB')).toBe('en-GB-u-nu-latn');
  });

  it('formats English (India): lakh grouping, rupees, day month year', () => {
    const en = translator('en', ENGLISH);
    expect(en.number(1234567)).toBe('12,34,567');
    expect(en.number(0.5, { style: 'percent' })).toBe('50%');
    expect(en.money(100000)).toBe('₹1,00,000.00');
    expect(en.money(1500.5)).toBe('₹1,500.50');
    expect(en.date('2026-10-20')).toBe('20 Oct 2026');
    expect(en.date('2026-04-01T23:30:00.000Z')).toBe('01 Apr 2026');
    expect(en.date('not a date')).toBe('not a date');
  });

  it('formats every shipped language with Indian grouping and its own month names', () => {
    for (const locale of ['hi', 'ta', 'te', 'bn', 'mr']) {
      const tr = translator(locale, {});
      expect(tr.number(1234567), locale).toBe('12,34,567');
      expect(tr.money(100000), locale).toContain('1,00,000.00');
      expect(tr.money(100000), locale).toContain('₹');
      const d = tr.date('2026-10-20');
      expect(d, locale).toContain('2026');
      expect(d, locale).toContain('20');
      expect(d, locale).not.toContain('Oct');
    }
  });

  it('the shared formatters follow the language in use', () => {
    expect(formatMoney(250000)).toBe('₹2,50,000.00');
    expect(formatNumber(100000)).toBe('1,00,000');
    expect(formatDate('2026-10-20')).toBe('20 Oct 2026');
    useMessages('hi', ENGLISH);
    expect(formatDate('2026-10-20')).not.toContain('Oct');
  });
});
