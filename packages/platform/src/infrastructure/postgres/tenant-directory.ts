import type { Database } from './db.js';
import type { ConnectorOutbox } from '../../application/connectors/ports/connector-runtime.js';
import type { RetentionScan } from '../../application/files/ports/retention-scan.js';
import type { OrganisationLifecycle, TenantDirectory } from '../../domain/organisations/ports/organisation-directory.js';
import type { AccountStore, MemberDirectory, SessionStore, SignInStore, SystemIdentity } from '../../domain/identity/ports/identity-directory.js';
import type { PasskeyStore } from '../../domain/identity/ports/passkey-store.js';
import type { DefinitionBase } from '../../runtime/definitions/ports/definition-base.js';
import type { ManagedIndexes } from '../../runtime/definitions/ports/managed-indexes.js';
import { pgAccountStore } from './stores/owner/account.js';
import { pgDefinitionBase } from './stores/owner/definition-base.js';
import { pgManagedIndexes } from './stores/owner/managed-indexes.js';
import { pgMemberDirectory } from './stores/owner/member-directory.js';
import { pgOrganisationLifecycle } from './stores/owner/organisation-lifecycle.js';
import { pgOutboxRequeue } from './stores/owner/outbox-requeue.js';
import { pgRetentionScan } from './stores/owner/retention-scan.js';
import { pgSessionStore } from './stores/owner/session.js';
import { pgPasskeyStore } from './stores/owner/passkey-store.js';
import { pgSignInStore } from './stores/owner/sign-in.js';
import { pgSystemIdentity } from './stores/owner/system-identity.js';
import { pgTenantDirectory } from './stores/owner/tenant-directory.js';

/** What the database installation provides. */
export interface DatabaseCatalog {
  hasTrigram(): Promise<boolean>;
}

/** Checks against PostgreSQL's own catalogs, which are not engine tables (test/raw-sql-baseline.json). */
function catalogChecks(db: Database) {
  return {
    async hasTrigram() {
      const [trigram] = await db.asSystem((tx) => tx.query(`select 1 from pg_extension where extname = 'pg_trgm'`));
      return !!trigram;
    },
    async indexIsInvalid(name: string) {
      const [invalid] = await db.asSystem((tx) =>
        tx.query(
          `select 1 from pg_index x join pg_class c on c.oid = x.indexrelid join pg_namespace n on n.oid = c.relnamespace
            where c.relname = $1 and n.nspname = current_schema() and not x.indisvalid`,
          [name],
        ),
      );
      return !!invalid;
    },
  };
}

/** The owner-level capabilities, each a narrow store beside the core port it implements (stores/owner). */
export interface OwnerCapabilities {
  tenants: TenantDirectory;
  organisations: OrganisationLifecycle;
  outbox: ConnectorOutbox;
  retention: RetentionScan;
  definitionBase: DefinitionBase;
  indexes: ManagedIndexes;
  identity: SystemIdentity;
  accounts: AccountStore;
  signIn: SignInStore;
  passkeys: PasskeyStore;
  sessions: SessionStore;
  members: MemberDirectory;
  catalog: DatabaseCatalog;
}

/** The only owner-level operations services outside infrastructure may run. */
export function ownerCapabilities(db: Database): OwnerCapabilities {
  const catalog = catalogChecks(db);
  return {
    tenants: pgTenantDirectory(db),
    organisations: pgOrganisationLifecycle(db),
    outbox: pgOutboxRequeue(db),
    retention: pgRetentionScan(db),
    definitionBase: pgDefinitionBase(db),
    indexes: pgManagedIndexes(db, catalog.indexIsInvalid),
    identity: pgSystemIdentity(db),
    accounts: pgAccountStore(db),
    signIn: pgSignInStore(db),
    passkeys: pgPasskeyStore(db),
    sessions: pgSessionStore(db),
    members: pgMemberDirectory(db),
    catalog: { hasTrigram: catalog.hasTrigram },
  };
}
