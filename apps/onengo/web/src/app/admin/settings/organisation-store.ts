import { Injectable, computed, inject, signal } from '@angular/core';
import { failure } from '../../core/admin/roles';
import { formatDate, lowerLabel, t } from '../../core/i18n/i18n';
import type { ConfirmableStep, OrganisationView, Registration } from '../../core/organisation/organisation';
import {
  PROFILE_KEYS,
  REGISTRATION_KEYS,
  fieldIssues,
  profileChange,
  profileValues,
  logoProblem,
  signatoryErrors,
  signatureProblem,
  registrationLine,
  registrationRequest,
  registrationValues,
  setupDetailText,
  setupProgress,
  setupRows,
  setupStatusText,
  timezoneLabel,
  timezoneOptions,
} from '../../core/organisation/settings';
import { organisationSignInPath } from '../../core/organisation/sign-in';
import { listSource } from '../../core/ui-logic/autocomplete';
import { organisationLogo } from '../../core/shell/shell';
import type { FormValues } from '../../core/records/record/forms';
import { Organisation } from '../../services/organisation';
import type { CfFieldDef } from '../../ui/cf-types';
import { AdminBase } from '../admin-store';

/** Grey text in an empty box: "Enter display name". A label that opens with capitals, such as "API", keeps them. */
export function enterPlaceholder(labelKey: string): string {
  return t('ui.common.enterField', { field: lowerLabel(t(labelKey)) });
}

const field = (key: string, label: string, extra: Partial<CfFieldDef> = {}): CfFieldDef => ({
  key,
  label: t(label),
  type: 'text',
  required: false,
  readOnly: false,
  options: [],
  placeholder: enterPlaceholder(label),
  ...extra,
});

/**
 * The organisation record for its administrators: the setup checklist and its
 * confirmations, the logo, the profile (contact, address and time zone) and the
 * registrations. The names and language are saved by the settings store.
 * Field problems the server reports are shown on their fields.
 */
@Injectable()
export class OrganisationStore extends AdminBase {
  private readonly organisation = inject(Organisation);
  private readonly org = this.organisation.gateway;

  readonly view = signal<OrganisationView | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');

  readonly profile = signal<FormValues>({});
  readonly profileErrors = signal<Record<string, string>>({});
  readonly savingProfile = signal(false);

  /** `new`, a registration id, or null when no registration is being edited. */
  readonly editing = signal<string | null>(null);
  readonly registration = signal<FormValues>({});
  readonly registrationErrors = signal<Record<string, string>>({});
  readonly savingRegistration = signal(false);
  readonly removing = signal<string | null>(null);

  readonly logo = signal<string | null>(null);
  readonly logoError = signal('');
  readonly logoBusy = signal(false);

  readonly signatoryName = signal('');
  readonly signatoryDesignation = signal('');
  readonly signatoryErrors = signal<Record<string, string>>({});
  readonly signature = signal<string | null>(null);
  readonly signatureError = signal('');
  readonly signatoryBusy = signal(false);

  readonly confirming = signal<ConfirmableStep | null>(null);

  readonly signInLink = computed(() => (this.view() ? organisationSignInPath(this.view()!.code) : ''));
  /** The legal name is missing, so Profile says where it is kept. */
  readonly legalNameMissing = computed(() => !!this.view() && !this.view()!.legalName);
  readonly setup = computed(() => {
    this.i18n.locale();
    return setupRows(this.view()?.setup.items ?? []);
  });
  /** The home-page strip: required progress, and the line under the bar. */
  readonly setupSummary = computed(() => {
    this.i18n.locale();
    const progress = setupProgress(this.setup());
    return { ...progress, status: setupStatusText(progress), detail: setupDetailText(progress, this.i18n.locale()) };
  });
  readonly registrations = computed(() =>
    (this.view()?.registrations ?? []).map((r) => ({ id: r.id, line: registrationLine(r), dates: this.dates(r), notes: r.notes })),
  );
  /** The time zones the box searches; one list per organisation, so typing does not rebuild it. */
  private readonly timezones = computed(() => listSource(timezoneOptions(this.view()?.timezone ?? null).map((z) => ({ id: z.key, label: z.label })), 10));
  readonly contactFields = computed<CfFieldDef[]>(() => {
    this.i18n.locale();
    return [
      field('email', 'ui.admin.organisation.email', { type: 'email', required: true }),
      field('phone', 'ui.admin.organisation.phone', { maxLength: 20 }),
      field('website', 'ui.admin.organisation.website', { maxLength: 200, hint: t('ui.admin.organisation.websiteHint') }),
    ];
  });
  readonly addressFields = computed<CfFieldDef[]>(() => {
    this.i18n.locale();
    return [
      field('line1', 'ui.admin.organisation.line1', { required: true }),
      field('line2', 'ui.admin.organisation.line2'),
      field('city', 'ui.admin.organisation.city', { required: true }),
      field('state', 'ui.admin.organisation.state'),
      field('postalCode', 'ui.admin.organisation.postalCode', { required: true }),
      field('country', 'ui.admin.organisation.country', { required: true, maxLength: 2, hint: t('ui.admin.organisation.countryHint') }),
      field('timezone', 'ui.admin.organisation.timezone', {
        type: 'picker',
        required: true,
        picker: {
          source: this.timezones(),
          text: timezoneLabel(String(this.profile()['timezone'] ?? '')),
          choose: (option) => this.setProfileValue('timezone', option.id),
          clear: () => this.setProfileValue('timezone', ''),
        },
      }),
    ];
  });
  readonly registrationFields = computed<CfFieldDef[]>(() => {
    this.i18n.locale();
    return [
      field('type', 'ui.admin.organisation.regType', { required: true, maxLength: 40, hint: t('ui.admin.organisation.regTypeHint') }),
      field('number', 'ui.admin.organisation.regNumber', { required: true, maxLength: 80 }),
      field('issuingAuthority', 'ui.admin.organisation.regAuthority', { maxLength: 200 }),
      field('issuedOn', 'ui.admin.organisation.regIssuedOn', { type: 'date' }),
      field('expiresOn', 'ui.admin.organisation.regExpiresOn', { type: 'date' }),
      field('notes', 'ui.admin.organisation.regNotes', { type: 'textarea', maxLength: 500 }),
    ];
  });

  constructor() {
    super();
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.use(await this.org.view());
      this.error.set('');
    } catch (e) {
      this.error.set(failure(e));
    } finally {
      this.loading.set(false);
    }
  }

  /** One profile field, for the controls that write their own value, such as the time zone box. */
  setProfileValue(key: string, value: string): void {
    this.profile.update((v) => ({ ...v, [key]: value }));
  }

  async saveProfile(): Promise<void> {
    const o = this.view();
    if (!o || this.savingProfile()) return;
    const out = profileChange(o, this.profile());
    if ('errors' in out) return this.profileErrors.set(out.errors);
    this.profileErrors.set({});
    if (!Object.keys(out.profile).length) return;
    this.savingProfile.set(true);
    try {
      this.use(await this.org.saveProfile(out.profile));
      this.show({ ok: true, message: t('ui.admin.organisation.saved') });
    } catch (e) {
      const { message, errors } = fieldIssues(e, PROFILE_KEYS);
      this.profileErrors.set(errors);
      this.show({ ok: false, message });
    } finally {
      this.savingProfile.set(false);
    }
  }

  editRegistration(id: string | 'new'): void {
    const r = id === 'new' ? undefined : this.view()?.registrations.find((x) => x.id === id);
    this.editing.set(id);
    this.removing.set(null);
    this.registration.set(registrationValues(r));
    this.registrationErrors.set({});
  }

  cancelRegistration(): void {
    this.editing.set(null);
    this.registrationErrors.set({});
  }

  async saveRegistration(): Promise<void> {
    const id = this.editing();
    if (!id || this.savingRegistration()) return;
    const out = registrationRequest(this.registration());
    if ('errors' in out) return this.registrationErrors.set(out.errors);
    this.registrationErrors.set({});
    this.savingRegistration.set(true);
    try {
      if (id === 'new') await this.org.addRegistration(out.body);
      else await this.org.updateRegistration(id, out.body);
      this.editing.set(null);
      this.use(await this.org.view());
      this.show({ ok: true, message: t('ui.admin.organisation.registrationSaved') });
    } catch (e) {
      const { message, errors } = fieldIssues(e, REGISTRATION_KEYS, 'number');
      this.registrationErrors.set(errors);
      if (!Object.keys(errors).length) this.show({ ok: false, message });
    } finally {
      this.savingRegistration.set(false);
    }
  }

  async removeRegistration(id: string): Promise<void> {
    if (this.removing() !== id) return this.removing.set(id);
    try {
      await this.org.removeRegistration(id);
      this.removing.set(null);
      this.use(await this.org.view());
      this.show({ ok: true, message: t('ui.admin.organisation.registrationRemoved') });
    } catch (e) {
      this.show({ ok: false, message: failure(e) });
    }
  }

  async chooseLogo(file: File | undefined): Promise<void> {
    if (!file || this.logoBusy()) return;
    const problem = logoProblem(file);
    this.logoError.set(problem ?? '');
    if (problem) return;
    this.logoBusy.set(true);
    try {
      this.use(await this.org.setLogo(file));
      void this.organisation.refresh();
      this.show({ ok: true, message: t('ui.admin.organisation.logoSaved') });
    } catch (e) {
      const { message, errors } = fieldIssues(e, ['logo']);
      this.logoError.set(errors['logo'] ?? message);
    } finally {
      this.logoBusy.set(false);
    }
  }

  async saveSignatory(): Promise<void> {
    if (this.signatoryBusy()) return;
    const errors = signatoryErrors(this.signatoryName(), this.signatoryDesignation());
    this.signatoryErrors.set(errors);
    if (Object.keys(errors).length) return;
    this.signatoryBusy.set(true);
    try {
      this.use(await this.org.saveSignatory({ name: this.signatoryName().trim(), designation: this.signatoryDesignation().trim() }));
      this.show({ ok: true, message: t('ui.admin.organisation.signatorySaved') });
    } catch (e) {
      const { message, errors: field } = fieldIssues(e, ['name', 'designation']);
      this.signatoryErrors.set(field);
      if (!Object.keys(field).length) this.show({ ok: false, message });
    } finally {
      this.signatoryBusy.set(false);
    }
  }

  async chooseSignature(file: File | undefined): Promise<void> {
    if (!file || this.signatoryBusy()) return;
    const problem = signatureProblem(file);
    this.signatureError.set(problem ?? '');
    if (problem) return;
    this.signatoryBusy.set(true);
    try {
      this.use(await this.org.setSignature(file));
      this.show({ ok: true, message: t('ui.admin.organisation.signatorySaved') });
    } catch (e) {
      const { message, errors } = fieldIssues(e, ['signatory']);
      this.signatureError.set(errors['signatory'] ?? message);
    } finally {
      this.signatoryBusy.set(false);
    }
  }

  async removeSignatory(): Promise<void> {
    if (this.signatoryBusy()) return;
    this.signatoryBusy.set(true);
    try {
      await this.org.removeSignatory();
      this.signatureError.set('');
      this.signatoryErrors.set({});
      this.use(await this.org.view());
      this.show({ ok: true, message: t('ui.admin.organisation.signatoryRemoved') });
    } catch (e) {
      this.show({ ok: false, message: failure(e) });
    } finally {
      this.signatoryBusy.set(false);
    }
  }

  async removeLogo(): Promise<void> {
    if (this.logoBusy()) return;
    this.logoBusy.set(true);
    try {
      await this.org.removeLogo();
      this.logoError.set('');
      this.use(await this.org.view());
      void this.organisation.refresh();
      this.show({ ok: true, message: t('ui.admin.organisation.logoRemoved') });
    } catch (e) {
      this.show({ ok: false, message: failure(e) });
    } finally {
      this.logoBusy.set(false);
    }
  }

  async confirm(step: ConfirmableStep): Promise<void> {
    const o = this.view();
    if (!o || this.confirming()) return;
    this.confirming.set(step);
    try {
      const setup = await this.org.confirmSetup(step);
      this.view.set({ ...o, setup });
      this.show({ ok: true, message: t(setup.complete ? 'ui.admin.organisation.setupComplete' : 'ui.admin.organisation.confirmed') });
    } catch (e) {
      this.show({ ok: false, message: failure(e) });
    } finally {
      this.confirming.set(null);
    }
  }

  private dates(r: Registration): string {
    if (r.issuedOn && r.expiresOn) return t('ui.admin.organisation.regValid', { from: formatDate(r.issuedOn), to: formatDate(r.expiresOn) });
    if (r.issuedOn) return t('ui.admin.organisation.regIssued', { from: formatDate(r.issuedOn) });
    if (r.expiresOn) return t('ui.admin.organisation.regUntil', { to: formatDate(r.expiresOn) });
    return '';
  }

  private use(o: OrganisationView): void {
    const logoChanged = o.logo?.url !== this.view()?.logo?.url;
    const signatureChanged = o.signatory?.image?.url !== this.view()?.signatory?.image?.url;
    this.view.set(o);
    this.profile.set(profileValues(o));
    this.signatoryName.set(o.signatory?.name ?? '');
    this.signatoryDesignation.set(o.signatory?.designation ?? '');
    if (logoChanged) {
      const src = organisationLogo(o.logo?.url);
      if (!src) this.logo.set(null);
      else void this.organisation.image(src).then((d) => this.logo.set(d), () => this.logo.set(null));
    }
    if (!signatureChanged) return;
    const signature = organisationLogo(o.signatory?.image?.url);
    if (!signature) this.signature.set(null);
    else void this.organisation.image(signature).then((d) => this.signature.set(d), () => this.signature.set(null));
  }
}
