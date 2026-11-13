import type { Tx } from '../../../domain/ports/transaction.js';

export interface LogoRow {
  file_id: string;
  version: number;
  updated_at: Date | string;
}

export interface LogoFile {
  name: string;
  mime: string;
  size: number;
  storage_key: string;
  store_ref: string;
}

/** What the setup checklist needs to know beyond the profile. */
export interface SetupFacts {
  /** A financial year is open today. */
  fiscalYear: boolean;
  series: boolean;
  /** An active member holds a role other than `administratorRole`. */
  operationalRole: boolean;
  /** The organisation can send its own email: an enabled smtp connector or an enabled http email sender. */
  smtp: boolean;
  payments: boolean;
}

/** The organisation's names, logo and setup facts, inside its tenant transaction. */
export interface OrganisationAdminStore {
  identity(tx: Tx): Promise<{ key: string; name: string; legal_name: string | null } | undefined>;
  /** The display name; fails when the organisation is not there. */
  name(tx: Tx): Promise<string>;
  logo(tx: Tx): Promise<LogoRow | undefined>;
  /** `fileId` null: the current logo; otherwise that file when it is or was a logo kept by an issued receipt. */
  logoFile(tx: Tx, fileId: string | null): Promise<LogoFile | undefined>;
  /** Makes `fileId` the logo, one version after the one it replaces. */
  putLogo(tx: Tx, fileId: string, actorId: string): Promise<void>;
  removeLogo(tx: Tx): Promise<{ file_id: string } | undefined>;
  signatoryText(tx: Tx): Promise<{ name: string | null; designation: string | null }>;
  /** Writes the name and designation. An empty profile row is created when the organisation has none. */
  saveSignatoryText(tx: Tx, actorId: string, name: string, designation: string): Promise<{ name: string | null; designation: string | null }>;
  clearSignatoryText(tx: Tx, actorId: string): Promise<void>;
  /** The current signature image. */
  signatory(tx: Tx): Promise<LogoRow | undefined>;
  /** `fileId` null: the current signature; otherwise that file when it is or was a signature kept by an issued receipt. */
  signatoryFile(tx: Tx, fileId: string | null): Promise<LogoFile | undefined>;
  putSignatory(tx: Tx, fileId: string, actorId: string): Promise<void>;
  removeSignatory(tx: Tx): Promise<{ file_id: string } | undefined>;
  setupFacts(tx: Tx, administratorRole: string): Promise<SetupFacts>;
  /** The published organisation theme body, or null when none is published. A tenant theme replaces the platform one. */
  publishedTheme(tx: Tx): Promise<unknown>;
}
