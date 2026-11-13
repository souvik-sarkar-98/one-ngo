import { displayValue } from '../../fields/fields';
import { formatDate, formatMoney, t } from '../../i18n/i18n';
import type { ReceiptPrint, RuntimeAction, RuntimeRecordType } from '../../models';
import { registrationLine } from '../../organisation/settings';
import { organisationLogo } from '../../shell/shell';
import { receiptAmount } from '../record/present';

/** The issuer block at the top of the receipt. */
export interface ReceiptIssuerBlock {
  /** The legal name, or the display name without one. */
  name: string;
  /** The display name when it differs from the legal name. */
  alsoKnownAs: string | null;
  addressLines: string[];
  contactLine: string;
  registrations: string[];
  /** Same-origin; loaded with the person's sign-in. */
  logoUrl: string | null;
  /** Set when the receipt predates kept issuer identities and shows the current one. */
  note: string | null;
}

export interface ReceiptPage {
  organisation: string;
  issuer: ReceiptIssuerBlock;
  number: string;
  date: string;
  title: string;
  /** The acknowledgement sentence under the title, when the record names a donor. */
  statement: string | null;
  /** Label and value rows, in reading order. */
  rows: { label: string; value: string }[];
  /** The thank-you line printed above the signature. */
  thanks: string;
  /** Sentences kept with the receipt, such as a registration clause. */
  clauses: string[];
  /** Set when the receipt was cancelled; printed across the page. */
  voided: string | null;
  /** Where Back goes when there is no page to return to. */
  record: { type: string; id: string };
  /** The name and designation kept with the receipt. The image is loaded separately. */
  signatory: { name: string | null; designation: string | null } | null;
}

function issuerBlock(p: ReceiptPrint): ReceiptIssuerBlock {
  const i = p.issuer;
  if (!i) return { name: p.organisation.name, alsoKnownAs: null, addressLines: [], contactLine: '', registrations: [], logoUrl: null, note: null };
  const name = i.legalName || i.displayName;
  const a = i.address;
  return {
    name,
    alsoKnownAs: i.displayName && i.displayName !== name ? i.displayName : null,
    addressLines: a ? [a.line1, a.line2, [a.city, a.state, a.postalCode].filter(Boolean).join(', '), a.country].filter((x): x is string => !!x) : [],
    contactLine: [i.contact.email, i.contact.phone, i.contact.website].filter(Boolean).join(' · '),
    registrations: i.registrations.map(registrationLine),
    logoUrl: organisationLogo(i.logoUrl),
    note: p.issuerSource === 'current' ? t('ui.print.currentIssuer') : null,
  };
}

/**
 * The receipt print view: the issuer as kept with the receipt, then who gave,
 * how much, for which record, then the record's other filled-in fields from
 * its record type (sensitive values arrive masked). Nothing is loaded from
 * outside the app.
 */
export function receiptPage(p: ReceiptPrint, type?: RuntimeRecordType): ReceiptPage {
  const { receipt, record } = p;
  const kept = p.content;
  if (kept) {
    return {
      organisation: p.organisation.name,
      issuer: issuerBlock(p),
      number: receipt.number,
      date: formatDate(receipt.date),
      title: kept.title,
      statement: kept.statement,
      rows: kept.rows,
      thanks: kept.thanks,
      clauses: kept.clauses,
      voided: receipt.status === 'void' ? (receipt.voidReason ? t('ui.print.voidedBecause', { reason: receipt.voidReason }) : t('ui.records.void')) : null,
      record: { type: record.type, id: record.id },
      signatory: namesOf(p.issuer?.signatory),
    };
  }
  const titleKey = p.recordType.titleField ?? type?.titleField;
  const titleField = (type?.fields ?? []).find((f) => f.key === titleKey);
  const shown = new Set([titleKey, 'amount']);
  const from = titleKey ? record.data[titleKey] : undefined;
  const donor = from !== undefined && from !== null && from !== '' ? String(from) : null;
  const amount = receiptAmount(receipt.amount);
  const rows = [
    ...(donor !== null ? [{ label: titleField?.label || t('ui.print.receivedFrom'), value: donor }] : []),
    { label: t('ui.records.amount'), value: amount },
    { label: t('ui.print.forRecord', { type: p.recordType.label }), value: record.number ?? '—' },
    ...(type?.fields ?? [])
      .filter((f) => !shown.has(f.key) && f.type !== 'longText' && f.type !== 'reference')
      .map((f) => ({ label: f.label, value: displayValue(f, record.data[f.key]) }))
      .filter((r) => r.value !== '—'),
  ];
  return {
    organisation: p.organisation.name,
    issuer: issuerBlock(p),
    number: receipt.number,
    date: formatDate(receipt.date),
    title: p.series.label || t('ui.print.receipt'),
    statement: donor !== null ? t('ui.print.statement', { donor, amount, type: p.recordType.label }) : null,
    rows,
    thanks: t('ui.print.thanks'),
    clauses: [],
    voided: receipt.status === 'void' ? (receipt.voidReason ? t('ui.print.voidedBecause', { reason: receipt.voidReason }) : t('ui.records.void')) : null,
    record: { type: record.type, id: record.id },
    signatory: namesOf(p.issuer?.signatory),
  };
}

/** One filled-in line of the public receipt, in the same order as the signed-in print. */
export interface PublicReceiptField {
  label: string;
  value: string;
  kind: 'text' | 'date' | 'money' | 'boolean';
}

/** The public receipt page: the same receipt as Print, without record ids or file ids. */
export interface PublicReceiptView {
  number: string;
  date: string;
  amount: string;
  title: string;
  status: 'issued' | 'void';
  voidReason: string | null;
  /** The title field, labeled as on the record (Donor name), when it can be shown. */
  donor: { label: string; value: string } | null;
  recordTypeLabel: string;
  recordNumber: string | null;
  fields: PublicReceiptField[];
  issuerSource: 'issued' | 'current';
  issuer: {
    displayName: string;
    legalName: string | null;
    contact: { email: string | null; phone: string | null; website: string | null };
    address: { line1: string; line2: string | null; city: string; state: string | null; postalCode: string; country: string } | null;
    registrations: { type: string; number: string; issuingAuthority: string | null }[];
  };
  signatory: { name: string | null; designation: string | null } | null;
  hasLogo: boolean;
  hasSignature: boolean;
  /** Wording kept when the receipt was issued. Absent on older receipts. */
  content?: { title: string; statement: string | null; rows: { label: string; value: string }[]; clauses: string[]; thanks: string } | null;
}

export function publicReceiptPage(view: PublicReceiptView): ReceiptPage {
  if (view.content) {
    const issuer = issuerBlock({
      organisation: { name: view.issuer.displayName },
      issuer: { ...view.issuer, logoUrl: null },
      issuerSource: view.issuerSource,
    } as ReceiptPrint);
    return {
      organisation: view.issuer.displayName,
      issuer,
      number: view.number,
      date: formatDate(view.date),
      title: view.content.title || view.title || t('ui.print.receipt'),
      statement: view.content.statement,
      rows: view.content.rows,
      thanks: view.content.thanks,
      clauses: view.content.clauses,
      voided: view.status === 'void' ? (view.voidReason ? t('ui.print.voidedBecause', { reason: view.voidReason }) : t('ui.records.void')) : null,
      record: { type: '', id: '' },
      signatory: namesOf(view.signatory),
    };
  }
  const issuer = issuerBlock({
    organisation: { name: view.issuer.displayName },
    issuer: { ...view.issuer, logoUrl: null },
    issuerSource: view.issuerSource,
  } as ReceiptPrint);
  return {
    organisation: view.issuer.displayName,
    issuer,
    number: view.number,
    date: formatDate(view.date),
    title: view.title || t('ui.print.receipt'),
    statement: view.donor ? t('ui.print.statement', { donor: view.donor.value, amount: receiptAmount(view.amount), type: view.recordTypeLabel }) : null,
    rows: [
      ...(view.donor ? [{ label: view.donor.label, value: view.donor.value }] : []),
      { label: t('ui.records.amount'), value: receiptAmount(view.amount) },
      { label: t('ui.print.forRecord', { type: view.recordTypeLabel }), value: view.recordNumber ?? '—' },
      ...view.fields.map((field) => ({ label: field.label, value: publicValue(field) })),
    ],
    thanks: t('ui.print.thanks'),
    clauses: [],
    voided: view.status === 'void' ? (view.voidReason ? t('ui.print.voidedBecause', { reason: view.voidReason }) : t('ui.records.void')) : null,
    record: { type: '', id: '' },
    signatory: namesOf(view.signatory),
  };
}

function publicValue(field: PublicReceiptField): string {
  if (field.kind === 'date') return formatDate(field.value);
  if (field.kind === 'money') return formatMoney(Number(field.value));
  if (field.kind === 'boolean') return field.value === 'true' ? t('ui.common.yes') : t('ui.common.no');
  return field.value;
}

/** A public link is a publish step: only someone allowed to open the receipt may create or revoke one. */
export function canPublishReceiptLink(actions: readonly RuntimeAction[] | undefined): boolean {
  return !!actions?.some((action) => action.allowed && action.steps.some((step) => step.type === 'openReceipt'));
}

function namesOf(signatory: { name?: string | null; designation?: string | null } | null | undefined): ReceiptPage['signatory'] {
  if (!signatory?.name && !signatory?.designation) return null;
  return { name: signatory?.name ?? null, designation: signatory?.designation ?? null };
}
