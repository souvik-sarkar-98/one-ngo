import type { AuditInput } from '../../ports/audit-trail.js';
import type { Tx } from '../../ports/transaction.js';
import type { OrganisationProfileFields, OrganisationProfileState, Registration, RegistrationInput } from '../organisation.js';

/** The organisation's own profile and registrations, inside its tenant transaction. */
export interface OrganisationStore {
  readProfile(tx: Tx): Promise<OrganisationProfileState>;
  writeProfile(tx: Tx, actorId: string, profile: OrganisationProfileFields): Promise<void>;
  /** Marks a setup step as confirmed by the person; the first confirmation is kept. */
  confirmSetupStep(tx: Tx, actorId: string, step: 'identity' | 'receipts' | 'complete'): Promise<void>;
  registrations(tx: Tx): Promise<Registration[]>;
  /** Whether another registration (not `exceptId`) has this type and number. */
  registrationTaken(tx: Tx, r: RegistrationInput, exceptId: string | null): Promise<boolean>;
  /** Adds the registration; one with the same type and number already there is kept, and its id returned. */
  addRegistration(tx: Tx, actorId: string, r: RegistrationInput): Promise<string>;
  /** False when there is no such registration. */
  updateRegistration(tx: Tx, actorId: string, id: string, r: RegistrationInput): Promise<boolean>;
  removeRegistration(tx: Tx, id: string): Promise<{ type: string; number: string } | undefined>;
  audit(tx: Tx, entry: AuditInput): Promise<void>;
}
