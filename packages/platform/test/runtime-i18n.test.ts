import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { translatablePaths, translateBody } from '../src/runtime/definitions/translate.js';
import type { DefinitionBodies, DefinitionKind, RecordTypeDef } from '../src/runtime/definitions/types.js';
import { createWorld, expectCode, type TestWorld } from './helpers.js';

let w: TestWorld;
let hindi: Actor;
let english: Actor;

const catalogues = {
  en: { ui: { nav: { home: 'Home', records: 'Records', inbox: 'Inbox' }, records: { otherGroup: 'Other' } } },
  hi: { 'ui.nav.home': 'होम', 'ui.records.otherGroup': 'अन्य' },
};

async function publish<K extends DefinitionKind>(kind: K, body: DefinitionBodies[K]): Promise<void> {
  await w.platform.definitions.saveDraft(w.as(w.ngoA), kind, body);
  await w.platform.definitions.publish(w.as(w.ngoA), kind, body.key);
}
async function member(email: string, roles: string[], permissions: string[]): Promise<Actor> {
  const [u] = await w.platform.db.asSystem((tx) => tx.query<{ id: string }>(`insert into app_user (email, display_name) values ($1, $1) returning id`, [email]));
  await w.platform.db.asSystem((tx) => tx.query(`insert into tenant_member (tenant_id, user_id) values ($1, $2)`, [w.ngoA, u!.id]));
  return { id: u!.id, roles, permissions };
}

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false, localeCatalogues: catalogues });
  const perms = ['record:donation:*', 'record:donor:read'];
  hindi = await member('hi@example.org', ['finance'], perms);
  english = await member('en@example.org', ['finance'], perms);
  await publish('translation', {
    key: 'hi',
    locale: 'hi',
    entries: {
      'recordType.donation.label': 'दान',
      'recordType.donation.fields.amount.label': 'राशि',
      'recordType.donation.fields.method.choices.upi.label': 'यूपीआई',
      'workflow.donation.transitions.markPaid.label': 'भुगतान हुआ',
      'listView.donations.chips.outstanding.label': 'बकाया',
      'recordGroup.fundraising.label': 'धन संग्रह',
      'action.sendReminder.label': 'याद दिलाएँ',
      'template.donationThanks.subject': 'धन्यवाद, {{ record.donorName }}',
      'ui.nav.inbox': 'इनबॉक्स',
    },
  });
});
afterAll(() => w.close());

describe('translation paths', () => {
  it('name every readable text, and nothing else', async () => {
    const donation = (await w.platform.definitions.get(w.ngoA, 'recordType', 'donation'))!.body;
    const paths = translatablePaths('recordType', donation).map((p) => p.path);
    expect(paths).toEqual(expect.arrayContaining([
      'recordType.donation.label',
      'recordType.donation.pluralLabel',
      'recordType.donation.fields.amount.label',
      'recordType.donation.fields.donor.help',
      'recordType.donation.fields.method.choices.upi.label',
      'recordType.donation.fields.donorPan.patternMessage',
      'recordType.donation.rules.feeNotAboveAmount.message',
    ]));
    expect(paths.some((p) => /calculated|editableWhen|visibleWhen|copyFrom|key$/.test(p))).toBe(false);
  });

  it('replace only what is translated and leave the published definition alone', async () => {
    const body: RecordTypeDef = { key: 't', label: 'Thing', fields: [{ key: 'a', label: 'A', type: 'text' }, { key: 'b', label: 'B', type: 'text' }] };
    const out = translateBody('recordType', body, { 'recordType.t.fields.b.label': 'बी' });
    expect(out.fields.map((f) => f.label)).toEqual(['A', 'बी']);
    expect(out.label).toBe('Thing');
    expect(body.fields[1]!.label).toBe('B');
  });
});

describe('runtime definitions', () => {
  const get = async (actor: Actor, url: string) => {
    const app = buildServer(w.platform, { devAuth: true });
    const res = await app.inject({ method: 'GET', url, headers: { 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) } });
    await app.close();
    return res.json();
  };

  it('come translated, with English where nothing is translated', async () => {
    const d = await get(english, '/api/runtime/definitions?locale=hi');
    expect(d.locale).toBe('hi');
    const donation = d.recordTypes.find((t: { key: string }) => t.key === 'donation');
    expect(donation.label).toBe('दान');
    expect(donation.pluralLabel).toBe('Donations');
    expect(donation.fields.find((f: { key: string }) => f.key === 'amount').label).toBe('राशि');
    expect(donation.fields.find((f: { key: string }) => f.key === 'method').choices.find((c: { value: string }) => c.value === 'upi').label).toBe('यूपीआई');
    expect(d.workflows.donation.transitions.find((t: { key: string }) => t.key === 'markPaid').label).toBe('भुगतान हुआ');
    expect(d.listViews.donation.chips.find((c: { id: string }) => c.id === 'outstanding').label).toBe('बकाया');
    expect(d.recordGroups[0]).toMatchObject({ key: 'fundraising', label: 'धन संग्रह' });
    expect(d.actions.donation.find((a: { key: string }) => a.key === 'sendReminder').label).toBe('याद दिलाएँ');
    expect((await get(english, '/api/runtime/definitions')).recordTypes.find((t: { key: string }) => t.key === 'donation').label).toBe('Donation');
  });

  it('list actions per record type with whether the person may run them, without their settings', async () => {
    const viewer: Actor = { id: 'v-1', roles: ['viewer'], permissions: ['record:donation:read'] };
    const d = await get(viewer, '/api/runtime/definitions');
    const pay = d.actions.donation.find((a: { key: string }) => a.key === 'payNow');
    expect(pay).toMatchObject({ label: 'Pay now', placement: ['panel'], allowed: false, steps: [{ type: 'createPayment' }] });
    expect(JSON.stringify(d.actions)).not.toContain('onPaid');
    expect((await get(english, '/api/runtime/definitions')).actions.donation.every((a: { allowed: boolean }) => a.allowed)).toBe(true);
  });

  it('list every workflow of a record type, primary first', async () => {
    await publish('workflow', {
      key: 'audit',
      recordType: 'donation',
      role: 'parallel',
      initial: 'due',
      states: [{ key: 'due', label: 'Due' }, { key: 'checked', label: 'Checked' }],
      transitions: [{ key: 'check', label: 'Check', from: ['due'], to: 'checked' }],
    });
    const d = await get(english, '/api/runtime/definitions');
    expect(d.workflowSets.donation.map((x: { key: string; role?: string }) => [x.key, x.role ?? 'primary'])).toEqual([
      ['donation', 'primary'],
      ['audit', 'parallel'],
    ]);
    expect(d.workflows.donation.key).toBe('donation');
    expect(d.workflowSets.donation[1].transitions[0]).toMatchObject({ key: 'check', allowed: true });
  });

  it('include pages for the person’s roles, without widgets for record types they cannot read', async () => {
    await publish('page', {
      key: 'home',
      label: 'Home',
      widgets: [
        { type: 'groups' },
        { type: 'stat', label: 'Raised', recordType: 'donation', measure: 'count' },
        { type: 'stat', label: 'Donors', recordType: 'donor', measure: 'count' },
      ],
    });
    await publish('page', { key: 'finance', label: 'Finance desk', audience: ['finance'], widgets: [{ type: 'groups' }] });
    const outsider: Actor = { id: 'o-1', roles: ['viewer'], permissions: ['record:donation:read'] };
    const o = await get(outsider, '/api/runtime/definitions');
    expect(o.pages[0]).not.toHaveProperty('placement');
    expect(o.pages.map((p: { key: string }) => p.key)).toEqual(['home']);
    expect(o.pages[0].widgets.map((x: { type: string; label?: string }) => x.label ?? x.type)).toEqual(['groups', 'Raised']);
    expect((await get(english, '/api/runtime/definitions')).pages.map((p: { key: string }) => p.key)).toEqual(['home', 'finance']);
  });
});

describe('languages', () => {
  const call = async (actor: Actor, method: 'GET' | 'PUT', url: string, payload?: unknown) => {
    const app = buildServer(w.platform, { devAuth: true });
    const res = await app.inject({ method, url, payload: payload as object, headers: { 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) } });
    await app.close();
    return res;
  };

  it('are chosen by each person, falling back to the organisation default', async () => {
    expect((await call(hindi, 'PUT', '/api/me/locale', { locale: 'hi' })).json()).toEqual({ locale: 'hi' });
    expect((await call(hindi, 'GET', '/api/people/me')).json().locale).toBe('hi');
    expect((await call(hindi, 'GET', '/api/runtime/definitions')).json().locale).toBe('hi');
    expect((await call(english, 'GET', '/api/people/me')).json().locale).toBe('en');
    await w.platform.db.asSystem((tx) => tx.query(`update tenant set default_locale = 'ta' where id = $1`, [w.ngoA]));
    expect((await call(english, 'GET', '/api/people/me')).json().locale).toBe('ta');
    await w.platform.db.asSystem((tx) => tx.query(`update tenant set default_locale = 'en' where id = $1`, [w.ngoA]));
    expect((await call(hindi, 'PUT', '/api/me/locale', { locale: 'xx' })).statusCode).toBe(422);
    expect((await call(hindi, 'PUT', '/api/me/locale', { locale: 'Hindi' })).statusCode).toBe(422);
    await expectCode(w.platform.runtime.setLocale(w.as(w.ngoA, { id: 'not-a-member', roles: [], permissions: [] }), 'hi'), 'not_found');
  });

  it('carry into the invitation link, so the set-password page opens in the organisation’s language', async () => {
    await w.platform.db.asSystem((tx) => tx.query(`update tenant set default_locale = 'hi' where id = $1`, [w.ngoA]));
    const invited = await member('newcomer@example.org', [], []);
    w.mail.sent.length = 0;
    await w.platform.identity.inviteMember(w.as(w.ngoA), invited.id);
    await w.platform.db.asSystem((tx) => tx.query(`update tenant set default_locale = 'en' where id = $1`, [w.ngoA]));
    const link = new URL(/(https:\/\/ngo\.test\S+)/.exec(w.mail.sent[0]!.text)![1]!);
    expect(link.searchParams.get('lang')).toBe('hi');
    expect(link.searchParams.get('kind')).toBe('invite');
  });

  it('give screen text from the shipped catalogue, English where missing, then the organisation’s wording', async () => {
    const res = (await call(hindi, 'GET', '/api/runtime/messages')).json();
    expect(res).toEqual({
      locale: 'hi',
      messages: { 'ui.nav.home': 'होम', 'ui.nav.records': 'Records', 'ui.nav.inbox': 'इनबॉक्स', 'ui.records.otherGroup': 'अन्य' },
    });
    expect((await call(hindi, 'GET', '/api/runtime/messages?locale=en')).json().messages['ui.nav.home']).toBe('Home');
  });

  it('are used for template notifications to each recipient', async () => {
    const { record } = await w.platform.records.create(w.as(w.ngoA, english), 'donation', { donorName: 'Kiran', amount: 10 });
    await w.platform.notifications.notify(w.ngoA, {
      template: 'donationThanks',
      to: { users: [hindi.id, english.id] },
      channels: ['inApp'],
      scope: { record: { ...record.data, number: record.number } },
      recordId: record.id,
    });
    const [h] = await w.platform.notifications.inbox(w.as(w.ngoA, hindi));
    const [e] = await w.platform.notifications.inbox(w.as(w.ngoA, english));
    expect(h!.subject).toBe('धन्यवाद, Kiran');
    expect(h!.body).toMatch(/^Dear Kiran/);
    expect(e!.subject).toBe('Thank you for your donation, Kiran');
  });
});
