import { describe, expect, it } from 'vitest';
import { removeEntries, setEntry } from './ops/translation';
import {
  filterTranslationRows,
  lostPlaceholders,
  newTranslationKey,
  parseTranslationsAddress,
  staleEntries,
  translatablePaths,
  translatedShare,
  translationFor,
  translationRows,
  translationsParams,
  type TranslationSources,
} from './translations';

const donation = {
  key: 'donation',
  label: 'Donation',
  pluralLabel: 'Donations',
  titleField: 'donorName',
  fields: [
    { key: 'amount', label: 'Amount', type: 'money', help: 'In rupees', visibleWhen: 'true' },
    { key: 'method', label: 'Method', type: 'choice', choices: [{ value: 'upi', label: 'UPI' }, { value: 'cash', label: 'Cash' }] },
  ],
};
const home = {
  key: 'home',
  label: 'Home',
  widgets: [{ type: 'stat', label: 'Raised this month', recordType: 'donation', measure: 'sum', field: 'amount' }, { type: 'groups' }, { type: 'links', label: 'Quick links', items: [{ label: 'Donors', to: '/records/donor' }] }],
};
const thanks = { key: 'donationThanks', subject: 'Thank you, {{ record.donorName }}', body: 'We received {{record.amount}}.' };

const sources: TranslationSources = {
  definitions: [
    { kind: 'page', body: home },
    { kind: 'recordType', body: donation },
    { kind: 'template', body: thanks },
    { kind: 'theme', body: { key: 'organisation', label: 'Organisation theme' } },
  ],
  english: { 'ui.locale.name': 'English', 'ui.list.loadingMore': 'Loading more…', 'ui.records.count.one': '{count} record', 'ui.records.count.other': '{count} records' },
  app: { 'ui.locale.name': 'हिन्दी', 'ui.list.loadingMore': 'और लोड हो रहा है…' },
};

describe('translatable paths', () => {
  it('names the readable texts of a definition by key, id, value or position', () => {
    expect(translatablePaths('recordType', donation)).toEqual([
      { path: 'recordType.donation.label', text: 'Donation' },
      { path: 'recordType.donation.pluralLabel', text: 'Donations' },
      { path: 'recordType.donation.fields.amount.label', text: 'Amount' },
      { path: 'recordType.donation.fields.amount.help', text: 'In rupees' },
      { path: 'recordType.donation.fields.method.label', text: 'Method' },
      { path: 'recordType.donation.fields.method.choices.upi.label', text: 'UPI' },
      { path: 'recordType.donation.fields.method.choices.cash.label', text: 'Cash' },
    ]);
    expect(translatablePaths('page', home).map((p) => p.path)).toEqual([
      'page.home.label',
      'page.home.widgets.0.label',
      'page.home.widgets.2.label',
      'page.home.widgets.2.items.0.label',
    ]);
    expect(translatablePaths('template', thanks).map((p) => p.path)).toEqual(['template.donationThanks.subject', 'template.donationThanks.body']);
  });

  it('leaves out keys, expressions and addresses', () => {
    const paths = translatablePaths('recordType', donation).map((p) => p.path);
    expect(paths.some((p) => /titleField|visibleWhen|type$|\.key$|\.value$/.test(p))).toBe(false);
  });
});

describe('translation rows', () => {
  it('lists the definitions by kind, then the screen text, with where each translation comes from', () => {
    const rows = translationRows(sources, { 'recordType.donation.label': 'दान', 'ui.records.count.other': '{count} रिकॉर्ड' });
    expect(rows.map((r) => r.path)).toEqual([
      'recordType.donation.label',
      'recordType.donation.pluralLabel',
      'recordType.donation.fields.amount.label',
      'recordType.donation.fields.amount.help',
      'recordType.donation.fields.method.label',
      'recordType.donation.fields.method.choices.upi.label',
      'recordType.donation.fields.method.choices.cash.label',
      'page.home.label',
      'page.home.widgets.0.label',
      'page.home.widgets.2.label',
      'page.home.widgets.2.items.0.label',
      'template.donationThanks.subject',
      'template.donationThanks.body',
      'ui.locale.name',
      'ui.list.loadingMore',
      'ui.records.count.one',
      'ui.records.count.other',
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.path, r]));
    expect(by['recordType.donation.label']).toMatchObject({ area: 'recordType', english: 'Donation', translation: 'दान', origin: 'organisation' });
    expect(by['recordType.donation.pluralLabel']).toMatchObject({ translation: '', origin: 'missing' });
    expect(by['ui.list.loadingMore']).toMatchObject({ area: 'ui', translation: 'और लोड हो रहा है…', origin: 'app' });
    expect(by['ui.records.count.other']).toMatchObject({ origin: 'organisation', lost: [] });
    expect(by['ui.records.count.one']).toMatchObject({ origin: 'missing' });
  });

  it('an organisation entry wins over the app translation', () => {
    const rows = translationRows(sources, { 'ui.list.loadingMore': 'और…' });
    expect(rows.find((r) => r.path === 'ui.list.loadingMore')).toMatchObject({ translation: 'और…', origin: 'organisation' });
  });

  it('flags placeholders a translation leaves out', () => {
    expect(lostPlaceholders('Thank you, {{ record.donorName }}', 'धन्यवाद')).toEqual(['{{ record.donorName }}']);
    expect(lostPlaceholders('Thank you, {{ record.donorName }}', 'धन्यवाद, {{record.donorName}}')).toEqual([]);
    expect(lostPlaceholders('{count} records', 'रिकॉर्ड')).toEqual(['{count}']);
    expect(lostPlaceholders('{count} records', '')).toEqual([]);
    const rows = translationRows(sources, { 'template.donationThanks.subject': 'धन्यवाद' });
    expect(rows.find((r) => r.path === 'template.donationThanks.subject')!.lost).toEqual(['{{ record.donorName }}']);
  });

  it('finds entries that point to nothing any more', () => {
    const entries = { 'recordType.donation.label': 'दान', 'recordType.donation.fields.gone.label': 'x', 'listView.donations.chips.closed.label': 'y' };
    expect(staleEntries(entries, translationRows(sources, entries))).toEqual(['recordType.donation.fields.gone.label', 'listView.donations.chips.closed.label']);
  });

  it('filters by area, missing only and a search over path and both texts', () => {
    const rows = translationRows(sources, { 'recordType.donation.label': 'दान' });
    expect(filterTranslationRows(rows, { missing: false, q: '', area: 'ui' }).map((r) => r.path)).toEqual(['ui.locale.name', 'ui.list.loadingMore', 'ui.records.count.one', 'ui.records.count.other']);
    expect(filterTranslationRows(rows, { missing: true, q: '', area: 'ui' }).map((r) => r.path)).toEqual(['ui.records.count.one', 'ui.records.count.other']);
    expect(filterTranslationRows(rows, { missing: false, q: 'दान' }).map((r) => r.path)).toEqual(['recordType.donation.label']);
    expect(filterTranslationRows(rows, { missing: false, q: 'RAISED' }).map((r) => r.path)).toEqual(['page.home.widgets.0.label']);
    expect(filterTranslationRows(rows, { missing: false, q: 'widgets.2' })).toHaveLength(2);
  });

  it('works out how much is translated', () => {
    const rows = translationRows(sources, { 'recordType.donation.label': 'दान' });
    expect(translatedShare(rows)).toBe(Math.floor((3 * 100) / 17));
    expect(translatedShare([])).toBe(0);
  });
});

describe('translations address', () => {
  const reader = (q: string) => {
    const p = new URLSearchParams(q);
    return (n: string) => p.get(n);
  };

  it('reads the language, missing only, search and area, dropping what is invalid', () => {
    expect(parseTranslationsAddress(reader('locale=hi&missing=true&q=amount&area=page'))).toEqual({ locale: 'hi', missing: true, q: 'amount', area: 'page' });
    expect(parseTranslationsAddress(reader('locale=Hindi&missing=yes&area=theme'))).toEqual({ missing: false, q: '' });
  });

  it('writes only what changes, removing empty values', () => {
    expect(translationsParams({ missing: false, q: '' })).toEqual({ missing: null, q: null });
    expect(translationsParams({ locale: 'ta', area: 'ui' })).toEqual({ locale: 'ta', area: 'ui' });
  });
});

describe('translation definitions', () => {
  it('finds the one for a language, or names a new one', () => {
    const all = [{ key: 'hindi', locale: 'hi' }, { key: 'ta', locale: 'ta' }];
    expect(translationFor('hi', all)).toBe('hindi');
    expect(translationFor('bn', all)).toBeNull();
    expect(newTranslationKey('bn', ['hindi', 'ta'])).toBe('bn');
    expect(newTranslationKey('ta', ['hindi', 'ta', 'ta2'])).toBe('ta3');
    expect(newTranslationKey('pt-BR', [])).toBe('ptBR');
  });

  it('sets and clears entries without touching the rest', () => {
    const body = { key: 'hi', locale: 'hi', entries: { 'ui.a': 'क' } };
    const set = setEntry(body, 'recordType.donation.label', 'दान');
    expect(set.entries).toEqual({ 'ui.a': 'क', 'recordType.donation.label': 'दान' });
    expect(body.entries).toEqual({ 'ui.a': 'क' });
    expect(setEntry(set, 'ui.a', '  ').entries).toEqual({ 'recordType.donation.label': 'दान' });
    expect(removeEntries(set, ['ui.a', 'ui.none']).entries).toEqual({ 'recordType.donation.label': 'दान' });
  });
});
