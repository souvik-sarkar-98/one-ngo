import type { Tx } from '../../../domain/ports/transaction.js';

export interface LogoRow {
  file_id: string;
  version: number;
  updated_at: Date | string;
}

export interface SignatoryRow {
  id: string;
  name: string;
  designation: string;
  file_id: string | null;
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
  /** An enabled HTTP send connector is chosen in settings, or still carries the old email-sender flag. */
  email: boolean;
  /** Settings names an enabled storage connector. */
  fileStore: boolean;
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
  /** Every signatory, oldest first. */
  signatories(tx: Tx): Promise<SignatoryRow[]>;
  /** Every ordered set, by document key. */
  signatoryUses(tx: Tx): Promise<{ signatory_id: string; document_key: string; position: number }[]>;
  /** One document's set, in print order. */
  assigned(tx: Tx, documentKey: string): Promise<SignatoryRow[]>;
  addSignatory(tx: Tx, actorId: string, name: string, designation: string): Promise<string>;
  /** False when the signatory is not there. */
  updateSignatory(tx: Tx, id: string, actorId: string, name: string, designation: string): Promise<boolean>;
  /** Replaces the signature image and returns the one it replaced. Undefined when the signatory is not there. */
  putSignatoryImage(tx: Tx, id: string, fileId: string, actorId: string): Promise<{ file_id: string | null } | undefined>;
  /** Undefined when the signatory is not there. `inUse` when it is still printed on receipts or reports. */
  removeSignatory(tx: Tx, id: string): Promise<{ file_id: string | null } | 'in_use' | undefined>;
  /** Replaces one document's ordered set. The ids are known to exist; none clears the document's own set. */
  replaceDocumentSignatories(tx: Tx, documentKey: string, signatoryIds: string[]): Promise<void>;
  /** That file when it is a current signature or one an issued receipt or published report keeps. */
  signatoryFile(tx: Tx, fileId: string): Promise<LogoFile | undefined>;
  setupFacts(tx: Tx, administratorRole: string): Promise<SetupFacts>;
  /** The published organisation theme body, or null when none is published. A tenant theme replaces the platform one. */
  publishedTheme(tx: Tx): Promise<unknown>;
}
