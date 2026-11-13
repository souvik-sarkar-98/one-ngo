import type { OrganisationGateway, OrganisationView, Registration, SetupChecklist } from './organisation';

const fail = (code: string, message: string, issues: { path: string; message: string }[] = []) => Object.assign(new Error(message), { code, issues });

const DUPLICATE = 'The organisation already has a registration of this type with this number.';

/** The organisation's API in memory, keeping the server's observable rules the screens rely on. */
export function memoryOrganisation(start: Partial<OrganisationView> = {}) {
  const calls: { op: string; args: unknown[] }[] = [];
  const log = (op: string, ...args: unknown[]) => calls.push({ op, args: structuredClone(args) });
  let ids = 0;
  const flags = { identityConfirmed: false, receiptsReviewed: false, completedAt: null as string | null };
  let org: OrganisationView = {
    code: 'demo',
    displayName: 'Demo Foundation',
    legalName: 'Demo Foundation Trust',
    contact: { email: 'office@demo.test', phone: null, website: null },
    address: { line1: '12 MG Road', line2: null, city: 'Pune', state: 'MH', postalCode: '411001', country: 'IN' },
    timezone: 'Asia/Kolkata',
    registrations: [],
    logo: null,
    signatory: null,
    setup: { complete: false, completedAt: null, items: [] },
    ...structuredClone(start),
  };
  const active = new Set(['demo']);

  const checklist = (): SetupChecklist => {
    const items: SetupChecklist['items'] = [
      { key: 'identity', required: true, done: flags.identityConfirmed && !!org.legalName && !!org.address && !!org.contact.email },
      { key: 'registrations', required: true, done: org.registrations.length > 0 },
      { key: 'fiscalYear', required: true, done: true },
      { key: 'receiptSeries', required: true, done: flags.receiptsReviewed },
      { key: 'operationalRole', required: true, done: true },
      { key: 'email', required: false, done: false, detail: 'none' },
      { key: 'payments', required: false, done: false },
    ];
    const complete = items.every((i) => !i.required || i.done);
    if (complete && !flags.completedAt) flags.completedAt = '2026-10-26T09:00:00.000Z';
    return { complete, completedAt: flags.completedAt, items };
  };
  const view = (): OrganisationView => structuredClone({ ...org, setup: checklist() });
  const taken = (type: string, number: string, except: string | null) => org.registrations.some((r) => r.id !== except && r.type === type && r.number === number.toUpperCase());
  const shaped = (id: string, body: Parameters<OrganisationGateway['addRegistration']>[0]): Registration => {
    if (body.issuedOn && body.expiresOn && body.expiresOn < body.issuedOn) {
      throw fail('validation_failed', 'The registration is not valid.', [{ path: 'expiresOn', message: 'The expiry date cannot be before the issue date.' }]);
    }
    return { id, type: body.type, number: body.number.toUpperCase(), issuingAuthority: body.issuingAuthority ?? null, issuedOn: body.issuedOn ?? null, expiresOn: body.expiresOn ?? null, notes: body.notes ?? null };
  };

  const gateway: OrganisationGateway = {
    async signInOrganisation(code) {
      log('signInOrganisation', code);
      if (!active.has(code)) throw fail('not_found', 'This organisation is not available. Check the sign-in link, or ask your organisation for it.');
      return { code, displayName: org.displayName, logoUrl: org.logo ? `/api/auth/organisations/${code}/logo?v=${org.logo.version}` : null, providers: [{ id: 'google', label: 'Google' }], theme: null };
    },
    async branding() {
      log('branding');
      return { code: org.code, displayName: org.displayName, logoUrl: org.logo?.url ?? null };
    },
    async view() {
      log('view');
      return view();
    },
    async saveProfile(change) {
      log('saveProfile', change);
      if (change.timezone !== undefined && !/^[A-Za-z_]+\/[A-Za-z_]+$/.test(change.timezone)) {
        throw fail('validation_failed', 'The organisation details are not valid.', [{ path: 'timezone', message: 'Use a time zone such as Asia/Kolkata.' }]);
      }
      if (change.contact?.email !== undefined && change.contact.email && !change.contact.email.includes('@')) {
        throw fail('validation_failed', 'The organisation details are not valid.', [{ path: 'contact.email', message: 'Enter a valid email address.' }]);
      }
      const contact = { ...org.contact };
      for (const [k, v] of Object.entries(change.contact ?? {})) contact[k as keyof typeof contact] = v || null;
      const address = change.address ? { line2: null, state: null, ...change.address } : org.address;
      org = { ...org, contact, address, timezone: change.timezone ?? org.timezone };
      return view();
    },
    async saveLegalName(legalName) {
      log('saveLegalName', legalName);
      org = { ...org, legalName };
    },
    async addRegistration(body) {
      log('addRegistration', body);
      if (taken(body.type, body.number, null)) throw fail('conflict', DUPLICATE);
      const r = shaped(`00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`, body);
      org.registrations.push(r);
      return structuredClone(r);
    },
    async updateRegistration(id, body) {
      log('updateRegistration', id, body);
      if (taken(body.type, body.number, id)) throw fail('conflict', DUPLICATE);
      const at = org.registrations.findIndex((r) => r.id === id);
      if (at < 0) throw fail('not_found', 'Registration not found.');
      org.registrations[at] = shaped(id, body);
      return structuredClone(org.registrations[at]!);
    },
    async removeRegistration(id) {
      log('removeRegistration', id);
      if (!org.registrations.some((r) => r.id === id)) throw fail('not_found', 'Registration not found.');
      org.registrations = org.registrations.filter((r) => r.id !== id);
    },
    async setLogo(file) {
      log('setLogo', file.type, file.size);
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw fail('validation_failed', 'The logo must be a PNG, JPEG or WebP image.', [{ path: 'logo', message: 'A PNG, JPEG or WebP image.' }]);
      const version = (org.logo?.version ?? 0) + 1;
      org = { ...org, logo: { url: `/api/organisation/logo?v=${version}`, version, updatedAt: '2026-10-26T09:00:00.000Z' } };
      return view();
    },
    async removeLogo() {
      log('removeLogo');
      if (!org.logo) throw fail('not_found', 'The organisation has no logo.');
      org = { ...org, logo: null };
    },
    async saveSignatory(body) {
      log('saveSignatory', body);
      if (!body.name.trim() || !body.designation.trim()) throw fail('validation_failed', 'The signatory is not valid.', [{ path: 'name', message: 'The name is required.' }]);
      org = { ...org, signatory: { name: body.name.trim(), designation: body.designation.trim(), image: org.signatory?.image ?? null } };
      return view();
    },
    async setSignature(file) {
      log('setSignature', file.type, file.size);
      if (file.type !== 'image/png') throw fail('validation_failed', 'The signature must be a PNG image.', [{ path: 'signatory', message: 'A PNG image.' }]);
      const version = (org.signatory?.image?.version ?? 0) + 1;
      org = { ...org, signatory: { name: org.signatory?.name ?? null, designation: org.signatory?.designation ?? null, image: { url: `/api/organisation/signatories/file?v=${version}`, version, updatedAt: '2026-10-26T09:00:00.000Z' } } };
      return view();
    },
    async removeSignatory() {
      log('removeSignatory');
      if (!org.signatory) throw fail('not_found', 'The organisation has no signatory.');
      org = { ...org, signatory: null };
    },
    async setup() {
      log('setup');
      return checklist();
    },
    async confirmSetup(step) {
      log('confirmSetup', step);
      if (step === 'identity') flags.identityConfirmed = true;
      else flags.receiptsReviewed = true;
      return checklist();
    },
    async image(url) {
      log('image', url);
      return new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
    },
  };
  return { gateway, calls, active, view };
}
