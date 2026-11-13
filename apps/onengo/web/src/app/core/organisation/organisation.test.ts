import { describe, expect, it } from 'vitest';
import type { HttpLike } from '../http/http';
import { httpOrganisation } from './http-organisation';
import { PRODUCT, browserTitle } from './organisation';
import { fieldIssues, profileChange, profileValues, logoProblem, registrationLine, registrationRequest, registrationValues, setupDetailText, setupProgress, setupRows, setupStatusText, timezoneOptions, PROFILE_KEYS, REGISTRATION_KEYS, type SetupRow } from './settings';
import { afterPasswordSet, organisationCode, organisationSignInPath, rememberedRedirect } from './sign-in';
import { memoryOrganisation } from './testing';

describe('OneNGO branding', () => {
  it('titles every screen <screen or NGO> | OneNGO', () => {
    expect(PRODUCT).toBe('OneNGO');
    expect(browserTitle('Records')).toBe('Records | OneNGO');
    expect(browserTitle('Helping Hands')).toBe('Helping Hands | OneNGO');
    expect(browserTitle('  ')).toBe('OneNGO');
    expect(browserTitle(null)).toBe('OneNGO');
  });
});

describe('organisation sign-in', () => {
  it('reads codes as the server does and links to the organisation page', () => {
    expect(organisationCode(' HelpingHands ')).toBe('helpinghands');
    expect(organisationCode('../admin')).toBe('');
    expect(organisationCode('')).toBe('');
    expect(organisationSignInPath('helpinghands')).toBe('/o/helpinghands/sign-in');
  });

  it('opens the remembered organisation from the generic sign-in, keeping where the person was going', () => {
    expect(rememberedRedirect('demo', { next: '/records' })).toEqual({ path: '/o/demo/sign-in', next: '/records' });
    expect(rememberedRedirect('demo', {})).toEqual({ path: '/o/demo/sign-in', next: null });
    expect(rememberedRedirect('', {})).toBeNull();
    expect(rememberedRedirect('demo', { another: '' })).toBeNull();
    expect(rememberedRedirect('demo', { ticket: 't1' })).toBeNull();
    expect(rememberedRedirect('demo', { message: 'Sign-in failed' })).toBeNull();
  });

  it('sends invitations and resets back to the organisation sign-in page', () => {
    expect(afterPasswordSet('demo')).toBe('/o/demo/sign-in');
    expect(afterPasswordSet(null)).toBe('/sign-in');
    expect(afterPasswordSet('not a code')).toBe('/sign-in');
  });

  it('gives unknown and inactive codes the same not-found answer', async () => {
    const m = memoryOrganisation();
    await expect(m.gateway.signInOrganisation('demo')).resolves.toMatchObject({ code: 'demo', displayName: 'Demo Foundation', providers: [{ id: 'google' }] });
    m.active.delete('demo');
    const inactive = await m.gateway.signInOrganisation('demo').catch((e: { code: string; message: string }) => e);
    const unknown = await m.gateway.signInOrganisation('nobody').catch((e: { code: string; message: string }) => e);
    expect(inactive).toMatchObject({ code: 'not_found' });
    expect(unknown).toEqual(inactive);
  });
});

describe('organisation HTTP gateway', () => {
  it('calls the organisation addresses, sending the logo as the body itself', async () => {
    const sent: [string, string, unknown?][] = [];
    const rec = (method: string) => async (url: string, body?: unknown) => {
      sent.push(body === undefined ? [method, url] : [method, url, body]);
      return {} as never;
    };
    const http: HttpLike & { blob(url: string): Promise<Blob> } = { get: rec('GET'), post: rec('POST'), put: rec('PUT'), patch: rec('PATCH'), delete: rec('DELETE'), blob: async (url) => (sent.push(['BLOB', url]), new Blob()) };
    const g = httpOrganisation(http);
    const logo = new Blob(['x'], { type: 'image/png' });
    await g.signInOrganisation('help hands');
    await g.branding();
    await g.view();
    await g.saveProfile({ timezone: 'Asia/Kolkata' });
    await g.saveLegalName('Helping Hands Trust');
    await g.addRegistration({ type: '80g', number: 'A1' });
    await g.updateRegistration('r/1', { type: '80g', number: 'A2' });
    await g.removeRegistration('r1');
    await g.setLogo(logo);
    await g.removeLogo();
    await g.setup();
    await g.confirmSetup('receiptSeries');
    await g.image('/api/organisation/logos/f1');
    expect(sent).toEqual([
      ['GET', '/api/auth/organisations/help%20hands'],
      ['GET', '/api/organisation'],
      ['GET', '/api/admin/organisation'],
      ['PUT', '/api/admin/organisation/profile', { timezone: 'Asia/Kolkata' }],
      ['PUT', '/api/admin/settings', { legalName: 'Helping Hands Trust' }],
      ['POST', '/api/admin/organisation/registrations', { type: '80g', number: 'A1' }],
      ['PUT', '/api/admin/organisation/registrations/r%2F1', { type: '80g', number: 'A2' }],
      ['DELETE', '/api/admin/organisation/registrations/r1'],
      ['PUT', '/api/admin/organisation/logo', logo],
      ['DELETE', '/api/admin/organisation/logo'],
      ['GET', '/api/admin/organisation/setup'],
      ['POST', '/api/admin/organisation/setup/receiptSeries/confirm'],
      ['BLOB', '/api/organisation/logos/f1'],
    ]);
  });
});

describe('organisation profile form', () => {
  it('sends only what changed: changed contact fields, the whole address and the time zone', async () => {
    const o = await memoryOrganisation().gateway.view();
    const v = profileValues(o);
    expect(profileChange(o, v)).toEqual({ profile: {} });
    expect(profileChange(o, { ...v, phone: '+91 20 1234 5678', website: '' })).toEqual({
      profile: { contact: { phone: '+91 20 1234 5678' } },
    });
    expect(profileChange(o, { ...v, city: 'Mumbai', country: 'in', timezone: 'Asia/Calcutta' })).toEqual({
      profile: { address: { line1: '12 MG Road', city: 'Mumbai', postalCode: '411001', country: 'IN', state: 'MH' }, timezone: 'Asia/Calcutta' },
    });
    expect(profileChange(o, { ...v, email: '' })).toEqual({ profile: { contact: { email: '' } } });
  });

  it('names each problem on its field before sending', async () => {
    const o = await memoryOrganisation().gateway.view();
    const v = profileValues(o);
    const out = profileChange(o, { ...v, line1: '', country: 'India', timezone: '' });
    expect(out).toEqual({
      errors: {
        line1: 'Address line 1 is required.',
        country: 'That is not a two-letter country code. India is IN.',
        timezone: 'Time zone is required.',
      },
    });
  });

  it('offers each time zone under its current name, once', () => {
    const keys = timezoneOptions('Asia/Calcutta').map((o) => o.key);
    expect(keys).toContain('Asia/Kolkata');
    expect(keys).not.toContain('Asia/Calcutta');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('puts server issues on their fields, from 400 schema paths and 422 field paths alike', () => {
    expect(fieldIssues({ code: 'bad_request', message: 'The request is not valid.', issues: [{ path: '/address/postalCode', message: 'is required' }] }, PROFILE_KEYS)).toEqual({
      message: 'The request is not valid.',
      errors: { postalCode: 'is required' },
    });
    expect(
      fieldIssues(
        { code: 'validation_failed', message: 'The organisation details are not valid.', issues: [{ path: 'contact.website', message: 'Enter a web address starting with https://.' }, { path: 'timezone', message: 'Use a time zone such as Asia/Kolkata.' }, { path: 'other', message: 'x' }] },
        PROFILE_KEYS,
      ).errors,
    ).toEqual({ website: 'Enter a web address starting with https://.', timezone: 'Use a time zone such as Asia/Kolkata.' });
  });
});

describe('registrations', () => {
  it('shapes a registration as the server takes it and checks it first', () => {
    expect(registrationRequest({ ...registrationValues(), type: ' 80G ', number: ' aaatc1234f ', issuedOn: '2020-04-01' })).toEqual({ body: { type: '80g', number: 'AAATC1234F', issuedOn: '2020-04-01' } });
    expect(registrationRequest({ ...registrationValues(), type: '80 g', issuedOn: '2026-01-01', expiresOn: '2025-01-01' })).toEqual({
      errors: { type: 'Lowercase letters, digits, - or _, e.g. 80g, 12a, fcra', number: 'Number is required.', expiresOn: 'The expiry date cannot be before the issue date.' },
    });
    expect(registrationLine({ type: '80g', number: 'AAATC1234F', issuingAuthority: 'Income Tax Department' })).toBe('80G · AAATC1234F · Income Tax Department');
  });

  it('adds, edits and removes; a duplicate type and number is shown on the number', async () => {
    const m = memoryOrganisation();
    const r = await m.gateway.addRegistration({ type: '80g', number: 'aaatc1234f' });
    expect(r.number).toBe('AAATC1234F');
    const dup = await m.gateway.addRegistration({ type: '80g', number: 'AAATC1234F' }).catch((e: unknown) => e);
    expect(fieldIssues(dup, REGISTRATION_KEYS, 'number').errors).toEqual({ number: 'The organisation already has a registration of this type with this number.' });
    const bad = await m.gateway.updateRegistration(r.id, { type: '80g', number: 'X', issuedOn: '2026-01-01', expiresOn: '2025-01-01' }).catch((e: unknown) => e);
    expect(fieldIssues(bad, REGISTRATION_KEYS, 'number').errors).toEqual({ expiresOn: 'The expiry date cannot be before the issue date.' });
    await m.gateway.updateRegistration(r.id, { type: '12a', number: 'X1' });
    expect((await m.gateway.view()).registrations.map(registrationLine)).toEqual(['12A · X1']);
    await m.gateway.removeRegistration(r.id);
    expect((await m.gateway.view()).registrations).toEqual([]);
  });
});

describe('logo', () => {
  it('refuses the types and sizes the server refuses, before uploading', () => {
    expect(logoProblem({ type: 'image/png', size: 1024 * 1024 })).toBeNull();
    expect(logoProblem({ type: 'image/webp', size: 10 })).toBeNull();
    expect(logoProblem({ type: 'image/svg+xml', size: 10 })).toBe('The logo must be a PNG, JPEG or WebP image.');
    expect(logoProblem({ type: 'image/jpeg', size: 1024 * 1024 + 1 })).toBe('The logo must be at most 1 MB.');
  });

  it('uploads, replaces and removes the logo; the shell branding follows', async () => {
    const m = memoryOrganisation();
    const v1 = await m.gateway.setLogo(new Blob(['a'], { type: 'image/png' }));
    expect(v1.logo).toMatchObject({ url: '/api/organisation/logo?v=1' });
    expect((await m.gateway.setLogo(new Blob(['b'], { type: 'image/webp' }))).logo?.version).toBe(2);
    expect((await m.gateway.branding()).logoUrl).toBe('/api/organisation/logo?v=2');
    const refused = await m.gateway.setLogo(new Blob(['<svg/>'], { type: 'image/svg+xml' })).catch((e: unknown) => e);
    expect(fieldIssues(refused, ['logo']).errors).toEqual({ logo: 'A PNG, JPEG or WebP image.' });
    await m.gateway.removeLogo();
    expect((await m.gateway.branding()).logoUrl).toBeNull();
  });
});

describe('setup checklist', () => {
  it('lists every item, offers the two confirmations, and completes once every required item is done', async () => {
    const m = memoryOrganisation();
    let rows = setupRows((await m.gateway.setup()).items);
    expect(rows.map((r) => [r.key, r.done, r.required, r.confirm])).toEqual([
      ['identity', false, true, true],
      ['registrations', false, true, false],
      ['fiscalYear', true, true, false],
      ['receiptSeries', false, true, true],
      ['operationalRole', true, true, false],
      ['email', false, false, false],
      ['payments', false, false, false],
    ]);
    expect(rows.find((r) => r.key === 'email')!.hint).toBe('No email is sent until an email connector is set up');
    expect(Object.fromEntries(rows.map((r) => [r.key, r.link]))).toEqual({
      identity: '/admin/organisation/profile',
      registrations: '/admin/organisation/registrations',
      fiscalYear: '/admin/organisation/settings',
      receiptSeries: '/builder?section=money&kind=receiptRule',
      operationalRole: '/admin/roles',
      email: '/admin/connectors',
      payments: '/admin/connectors',
    });
    expect(rows.every((r) => r.label && r.hint && !r.label.startsWith('ui.'))).toBe(true);
    await m.gateway.addRegistration({ type: '80g', number: 'A1' });
    await m.gateway.confirmSetup('identity');
    const done = await m.gateway.confirmSetup('receiptSeries');
    rows = setupRows(done.items);
    expect(done).toMatchObject({ complete: true, completedAt: '2026-10-26T09:00:00.000Z' });
    expect(rows.filter((r) => r.confirm)).toEqual([]);
  });

  it('fills the bar from required steps and names what is still required', () => {
    const rows: SetupRow[] = [
      row('identity', 'Organisation identity', true, true),
      row('registrations', 'Registrations', false, true),
      row('fiscalYear', 'Financial year', true, true),
      row('receiptSeries', 'Receipt series', true, true),
      row('operationalRole', 'People in roles', false, true),
      row('email', 'Outgoing email', false, false),
      row('payments', 'Online payments', false, false),
    ];
    const progress = setupProgress(rows);
    expect(progress).toEqual({ done: 3, total: 5, optionalOpen: 2, percent: 60, remaining: ['Registrations', 'People in roles'] });
    expect(setupStatusText(progress)).toBe('3 of 5 required · 2 optional open');
    expect(setupDetailText(progress, 'en')).toBe('Registrations and People in roles are still required.');

    const one = setupProgress(rows.map((item) => (item.key === 'operationalRole' ? { ...item, done: true } : item)));
    expect(setupDetailText(one, 'en')).toBe('Registrations is still required.');
  });

  it('says setup is complete once every required step is done, and drops the optional count when none are open', () => {
    const required = ['identity', 'registrations', 'fiscalYear', 'receiptSeries', 'operationalRole'] as const;
    const openOptional = required.map((key) => row(key, key, true, true)).concat([row('email', 'Outgoing email', false, false), row('payments', 'Online payments', false, false)]);
    const progress = setupProgress(openOptional);
    expect(progress.percent).toBe(100);
    expect(setupStatusText(progress)).toBe('5 of 5 required · 2 optional open');
    expect(setupDetailText(progress, 'en')).toBe('Setup is complete.');

    const finished = setupProgress(openOptional.map((item) => ({ ...item, done: true })));
    expect(setupStatusText(finished)).toBe('5 of 5 required');
    expect(setupDetailText(finished, 'en')).toBe('Setup is complete.');
  });
});

function row(key: SetupRow['key'], label: string, done: boolean, required: boolean): SetupRow {
  return { key, label, hint: '', done, required, confirm: false, link: '' };
}
