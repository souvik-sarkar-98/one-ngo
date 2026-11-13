import { formatDate, t } from '../../i18n/i18n';
import type { RecordView } from '../../models';
import type { Suggestion, SuggestionSource } from '../../ui-logic/autocomplete';
import { asGatewayError } from '../gateway/gateway';
import type { ListSpec } from '../spec';

export type ShareAccess = 'read' | 'edit';
export type PrincipalKind = 'user' | 'role';

/** A record shared with a person or a role, as the server lists it. */
export interface Share {
  id: string;
  principalKind: PrincipalKind;
  /** A person's user id or a role key. */
  principal: string;
  /** The person's name or the role's label. */
  name: string;
  access: ShareAccess;
  createdBy: string;
  createdAt: string;
  /** The moment the share ends; a date chosen as the end runs to the end of that day. */
  expiresAt: string | null;
}

/** Someone the record can be shared with. */
export interface ShareCandidate {
  principalKind: PrincipalKind;
  principal: string;
  name: string;
  email?: string;
  /** Whether their roles let them see records of this type at all; a share with anyone else gives no access. */
  canSee: boolean;
  /** Whether their roles let them edit records of this type, which an edit share still needs. */
  canEdit: boolean;
}

export interface ShareInput {
  principalKind: PrincipalKind;
  principal: string;
  access: ShareAccess;
  /** A date (`YYYY-MM-DD`, through the end of that day); left out for no end. */
  expiresAt?: string;
}

/** What sharing needs from the server. The only implementation that talks HTTP is in http-gateway.ts. */
export interface SharesGateway {
  list(type: string, id: string): Promise<Share[]>;
  /** Adds a share, or changes the access and end of the existing one for the same person or role. */
  share(type: string, id: string, input: ShareInput): Promise<Share>;
  remove(type: string, id: string, shareId: string): Promise<void>;
  /** People and roles matching the text, for whoever may manage the record's shares. */
  candidates(type: string, id: string, q: string): Promise<ShareCandidate[]>;
}

/** Share sits in the record panel's ⋮ for restricted records the person created or may share. */
export function canShare(spec: ListSpec, record: RecordView | null | undefined): boolean {
  return spec.type.visibility === 'restricted' && !!record?.canShare;
}

/** The last day a share runs, `YYYY-MM-DD`; null when it has no end. */
export function lastDay(expiresAt: string | null): string | null {
  return expiresAt ? new Date(Date.parse(expiresAt) - 1).toISOString().slice(0, 10) : null;
}

/** A role reads "Field officers (role)"; a person reads their name. */
export function shareName(s: Pick<Share, 'principalKind' | 'name'>): string {
  return s.principalKind === 'role' ? t('ui.share.roleName', { name: s.name }) : s.name;
}

/** "Can edit · until 31 Dec 2026" or "Can view · no end date". */
export function shareLine(s: Pick<Share, 'access' | 'expiresAt'>): string {
  const day = lastDay(s.expiresAt);
  return t('ui.share.line', {
    access: t(s.access === 'edit' ? 'ui.share.canEdit' : 'ui.share.canView'),
    end: day ? t('ui.share.until', { date: formatDate(day) }) : t('ui.share.noEnd'),
  });
}

/**
 * What the share would not give the chosen person or role: their roles leave
 * them unable to see the record type, or unable to edit it, which an edit
 * share still needs. '' when the share gives what it says.
 */
export function shareWarning(chosen: ShareCandidate | null, access: ShareAccess): string {
  if (!chosen) return '';
  const name = shareName(chosen);
  if (!chosen.canSee) return t('ui.share.cannotSee', { name });
  if (access === 'edit' && !chosen.canEdit) return t('ui.share.cannotEdit', { name });
  return '';
}

/** Up to two letters for the avatar. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0]!.toLocaleUpperCase())
    .join('');
}

export interface ShareDraft {
  chosen: ShareCandidate | null;
  access: ShareAccess;
  /** `YYYY-MM-DD`, or '' for no end. */
  expiresOn: string;
}

export interface ShareSnapshot {
  shares: Share[];
  loading: boolean;
  busy: boolean;
  draft: ShareDraft;
  /** Problems with the draft by part: `principal`, `access`, `expiresOn`. */
  errors: Record<string, string>;
  error: string;
  message: string;
  /** What the share does not give the chosen person or role; '' when it gives what it says. */
  warning: string;
}

const EMPTY_DRAFT: ShareDraft = { chosen: null, access: 'read', expiresOn: '' };
const IDLE: ShareSnapshot = { shares: [], loading: false, busy: false, draft: EMPTY_DRAFT, errors: {}, error: '', message: '', warning: '' };
const ISSUE_PARTS: Record<string, string> = { '/principalKind': 'principal', '/principal': 'principal', '/access': 'access', '/expiresAt': 'expiresOn' };

const candidateId = (c: Pick<ShareCandidate, 'principalKind' | 'principal'>) => `${c.principalKind}:${c.principal}`;
const todayUtc = () => new Date().toISOString().slice(0, 10);

/**
 * The share panel of one record: its shares, the person or role being added
 * with read or edit access and an optional last day, and removing a share.
 * The server decides who may share and with whom; this keeps the panel's
 * state and words the outcome.
 */
export class ShareSession {
  private snap: ShareSnapshot = IDLE;
  private readonly listeners = new Set<(s: ShareSnapshot) => void>();
  private recordId: string | null = null;
  private readonly seen = new Map<string, ShareCandidate>();

  constructor(
    private readonly gateway: SharesGateway,
    private readonly type: string,
    private readonly today: () => string = todayUtc,
  ) {}

  get snapshot(): ShareSnapshot {
    return this.snap;
  }

  subscribe(fn: (s: ShareSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snap);
    return () => this.listeners.delete(fn);
  }

  /** Loads the shares of a record, starting a fresh draft; the same record again keeps what is there. */
  async open(recordId: string): Promise<void> {
    if (this.recordId === recordId) return;
    this.recordId = recordId;
    this.seen.clear();
    this.set({ ...IDLE, loading: true });
    try {
      const shares = await this.gateway.list(this.type, recordId);
      if (this.recordId === recordId) this.set({ shares, loading: false });
    } catch (e) {
      if (this.recordId === recordId) this.set({ loading: false, error: asGatewayError(e, t('ui.share.loadFailed')).message });
    }
  }

  /** Forgets the record, so opening it again loads afresh. */
  close(): void {
    this.recordId = null;
    this.set(IDLE);
  }

  /** People (name, email) and roles ("role") matching the typed text. */
  readonly source: SuggestionSource = {
    minLength: 0,
    search: async (text) => {
      const id = this.recordId;
      if (!id) return [];
      const found = await this.gateway.candidates(this.type, id, text.trim());
      return found.map((c): Suggestion => {
        this.seen.set(candidateId(c), c);
        return { id: candidateId(c), label: c.name, hint: c.principalKind === 'role' ? t('ui.share.role') : c.email };
      });
    },
  };

  /** Takes a suggestion as the person or role to share with, or clears it with null. */
  choose(option: Suggestion | null): void {
    const { principal: _, ...errors } = this.snap.errors;
    this.setDraft({ chosen: option ? (this.seen.get(option.id) ?? null) : null }, errors);
  }

  setAccess(access: ShareAccess): void {
    this.setDraft({ access });
  }

  setExpiry(expiresOn: string): void {
    const { expiresOn: _, ...errors } = this.snap.errors;
    this.setDraft({ expiresOn }, errors);
  }

  /** Shares with the chosen person or role. Returns whether it was shared. */
  async share(): Promise<boolean> {
    const id = this.recordId;
    const { chosen, access, expiresOn } = this.snap.draft;
    if (!id || this.snap.busy) return false;
    const errors: Record<string, string> = {};
    if (!chosen) errors['principal'] = t('ui.share.choose');
    if (expiresOn && expiresOn < this.today()) errors['expiresOn'] = t('ui.share.pastEnd');
    if (Object.keys(errors).length) {
      this.set({ errors, message: '' });
      return false;
    }
    this.set({ busy: true, errors: {}, error: '', message: '' });
    const warning = shareWarning(chosen, access);
    try {
      const saved = await this.gateway.share(this.type, id, {
        principalKind: chosen!.principalKind,
        principal: chosen!.principal,
        access,
        ...(expiresOn ? { expiresAt: expiresOn } : {}),
      });
      if (this.recordId !== id) return false;
      const known = this.snap.shares.some((s) => s.id === saved.id);
      this.set({
        shares: known ? this.snap.shares.map((s) => (s.id === saved.id ? saved : s)) : [...this.snap.shares, saved],
        draft: EMPTY_DRAFT,
        message: t('ui.share.done', { name: shareName(saved), line: shareLine(saved) }),
        warning,
      });
      return true;
    } catch (e) {
      const err = asGatewayError(e, t('ui.common.somethingWentWrong'));
      const fields: Record<string, string> = {};
      for (const i of err.issues ?? []) {
        const part = ISSUE_PARTS[i.path];
        if (part && !fields[part]) fields[part] = i.message;
      }
      this.set({ errors: fields, error: Object.keys(fields).length ? '' : err.message });
      return false;
    } finally {
      this.set({ busy: false });
    }
  }

  /** Removes a share at once. */
  async remove(shareId: string): Promise<void> {
    const id = this.recordId;
    const share = this.snap.shares.find((s) => s.id === shareId);
    if (!id || !share || this.snap.busy) return;
    this.set({ busy: true, error: '', message: '' });
    try {
      await this.gateway.remove(this.type, id, shareId);
      if (this.recordId === id) this.set({ shares: this.snap.shares.filter((s) => s.id !== shareId), message: t('ui.share.removed', { name: shareName(share) }) });
    } catch (e) {
      this.set({ error: asGatewayError(e, t('ui.common.somethingWentWrong')).message });
    } finally {
      this.set({ busy: false });
    }
  }

  private setDraft(change: Partial<ShareDraft>, errors = this.snap.errors): void {
    const draft = { ...this.snap.draft, ...change };
    this.set({ draft, errors, warning: shareWarning(draft.chosen, draft.access) });
  }

  private set(change: Partial<ShareSnapshot>): void {
    this.snap = { ...this.snap, ...change };
    for (const fn of this.listeners) fn(this.snap);
  }
}
