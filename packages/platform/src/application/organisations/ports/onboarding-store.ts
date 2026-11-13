import type { OrganisationStore } from '../../../domain/organisations/ports/organisation-store.js';
import type { Tx } from '../../../domain/ports/transaction.js';

/** What onboarding checks before an organisation opens. Lists are null when not asked for. */
export interface ReadinessFacts {
  tenant: { name: string; legal_name: string | null } | undefined;
  profile: { email: string | null; address_line1: string | null; city: string | null; postal_code: string | null; country: string | null; timezone: string | null } | undefined;
  /** The administrator role's permissions, when the role exists. */
  administratorRole: string[] | undefined;
  /** Whether the administrator is an active member holding the administrator role. */
  administrator: boolean;
  enabledModules: string[] | null;
  presentSeries: string[] | null;
  /** The status of the financial year to open, when it exists. */
  fiscalYear: string | undefined;
}

/** The new organisation's setup steps, inside its tenant transaction. */
export interface OnboardingStore extends Pick<OrganisationStore, 'writeProfile' | 'addRegistration' | 'audit'> {
  /** Sets the prefix of those of `series` with no receipt yet; returns their keys. */
  setReceiptPrefix(tx: Tx, prefix: string, series: string[]): Promise<string[]>;
  fiscalYearOpened(tx: Tx, key: string): Promise<boolean>;
  setFiscalYearStart(tx: Tx, startMonth: number, actorId: string): Promise<void>;
  readiness(
    tx: Tx,
    query: { administratorRole: string; administratorId: string; modules: boolean; series: string[]; fiscalYear: string },
  ): Promise<ReadinessFacts>;
}
