# Provider contract suite

The portable behaviour every database provider must show (block P4, section 11
of `docs/architecture/ngo-backend-enhancement-plan.md`; ADR-13 in
`docs/architecture/ngo-management-platform.md` section 4.7). PostgreSQL passes
it; a provider migration is not released until it passes in full.

```powershell
npm run test:contract
```

It also runs in the normal `vitest run` (`vitest.config.ts` includes this
folder). It needs the test database that `packages/platform/test/global-setup.ts` prepares.

## Layout

| File | What it holds |
| --- | --- |
| `provider.ts` | `ProviderUnderTest`, the fixture a provider supplies, and the thin interfaces for pieces that are not ports yet |
| `contract.ts` | `defineProviderContract(provider)`: opens one world, runs every contract below |
| `*.contract.ts` | One contract each; they state behaviour through the ports, never SQL or plan shapes |
| `support.ts` | Record, ledger and receipt builders shared by the contracts |
| `postgres/fixture.ts` | The PostgreSQL fixture: isolated schema, stores, bypass handle, refusal mapping |
| `packages/platform/test/postgres-contract.test.ts` | Runs the suite against PostgreSQL; it hands the fixture the core's `transactions` and `joinTx`, which infrastructure may not import as values |

## Adding a provider

1. Write `<provider>/fixture.ts` exporting a `ProviderUnderTest`:
   - `capabilities`: the provider's `DatabaseCapabilities` (`packages/platform/src/domain/ports/database-capabilities.ts`).
   - `open()`: an isolated, fully migrated database with the provider's stores behind the ports, a `TransactionManager`, `newTenant()`, job queue, outbox dispatcher, index manager, a `BypassHandle` that writes to the tables directly inside a tenant transaction, and `refusal()` mapping the provider's errors to `duplicate`, `rule` or `isolation`.
   - `migrations`: the provider's file for a logical step, and empty databases to migrate.
2. Add `packages/platform/test/<provider>-contract.test.ts` calling `defineProviderContract(<provider>Provider(...))`.
3. Run it. Do not edit a contract to make a provider pass. Capabilities may only change how a rule is met (when balance is checked, whether workers skip locked rows, which text queries run), never whether tenancy, ledger or receipt rules hold.

## Coverage: section 11.3 ports

| Port | Required operations | Contract and tests |
| --- | --- | --- |
| `TransactionManager` | tenant-scoped transaction, rollback, isolation level | `transactions.contract.ts`: commits; rolls back on throw (record and outbox event); read-only refuses writes; repeatable read keeps one snapshot; joined transactions commit or roll back together; joining another organisation refused. `tenancy.contract.ts`: a non-id organisation refused |
| `RecordStore` | get, save with expected version, link, soft delete | `records.contract.ts`: insert and read back; duplicate number refused per type; link and unlink files; gap-free counter survives rollback. Optimistic writes: save at expected version, stale version refused, two concurrent saves at one version, exactly one wins |
| `RecordQuery` | validated AST, count, aggregate | `records.contract.ts` RecordQuery: type, status, equals, range (number and date), oneOf, number, search; ordering and paging; count, sums, grouped count and sum; bound values; a key outside the grammar refused |
| `DefinitionStore` | published snapshot, draft, publish, version, patch | `definitions.contract.ts`: draft kept apart until published; one draft; supersede and history; one published version; patch and config version; another organisation sees nothing |
| `LedgerStore` | protected writes, read models | `ledger.contract.ts`: post and trial balance with exact decimals, period close and reopen, reversal, one entry per record and rule, financial-year hold |
| `ReceiptStore` | protected writes, read models | `receipts.contract.ts`: series, issue with issuer snapshot, read by id and record, void, replacement |
| `OutboxStore` | append, claim lease, complete, fail, retry | `outbox.contract.ts`: delivered once per handler with organisation and payload; nothing on rollback; retry re-runs only unfinished handlers; failed after the last attempt; one of several concurrent dispatchers per event |
| `JobStore` | append, claim lease, complete, fail, retry | `jobs.contract.ts`: batches with saved state; failure with error; cancel; organisation-only reads; no claim while a lease holds, resume from saved state after it ends; one of several concurrent workers per job; exclusive jobs one at a time in order |
| `IndexManager` | create, remove, inspect a managed index | `indexes.contract.ts`: create reports ready and present, queries still match; unique caseless index per organisation and type; remove lifts the rule; create is idempotent |
| `MigrationRunner` | apply provider migration under the same logical id | `migrations.contract.ts`: applies once in order under logical ids; failed step leaves nothing, reported pending, applies once fixed; unknown applied step reported; out-of-order step refused; two concurrent runners apply each step once |

`ShareStore` and `FileCatalog` are used by the tenancy and record contracts.

## Coverage: section 11.5 invariants and ADR-13 criteria

| Invariant | Tests |
| --- | --- |
| Database-enforced tenant isolation (ADR-13 criterion 1) | `tenancy.contract.ts`: hidden through every read port; hidden from bypassing reads (records, journals, receipts, outbox, jobs); bypassing write stamped with another organisation refused; bypassing update changes nothing; capability profile never application-only |
| Unbalanced journals refused | `ledger.contract.ts`: through the store with no domain check; written directly (one line; unequal lines); line both or neither debit and credit, or negative |
| Closed-period writes refused | `ledger.contract.ts`: closed period refused, reopened accepted; date outside the period refused |
| Posted journals immutable | `ledger.contract.ts`: changed amount, memo and deletion refused; new lines on a posted entry refused, even a balanced pair (migration 022); reversed once, never back to posted |
| Receipt reuse refused | `receipts.contract.ts`: number and sequence position never reused; one live receipt per record and series; one replacement per void receipt; concurrent numbers distinct and consecutive; rollback returns the number |
| Illegal void changes refused | `receipts.contract.ts`: amount change, deletion, void without a reason, un-voiding and changing a void receipt refused when written directly |
| Stale writes refused by the database's conditional write | `records.contract.ts` optimistic writes |
| Money as exact decimals | `ledger.contract.ts` trial balance (0.10 + 0.20 = 0.30); `receipts.contract.ts` amount kept as `1500.50` |
| Migration recovery (ADR-13 criterion 4) | `migrations.contract.ts` failed step, unknown step, out-of-order step |

## Not covered

- **Record soft delete.** `RecordStore` has no delete operation yet; no production code soft-deletes records.
- **A migration process killed mid-file.** Needs provider-specific process control; `packages/platform/test/migrate.test.ts` covers it for PostgreSQL.
- **Performance and plan shapes** (ADR-13 criterion 5) and **operational qualification** (criterion 6): not portable behaviour; blocks P6 and O4.
