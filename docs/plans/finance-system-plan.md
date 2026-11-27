# Finance system plan

Written 2026-11-22. This is the remaining work on the finance system after the bank model change (a money account can attach to an existing ledger account) and the removal of the `bank-accounts` module. Built behaviour is in `architecture.md` section 7; shipping status is in `roadmap.md`.

Sizes are rough estimates (S under 2 days, M 2 to 5 days, L over 5 days), not measured. Items marked "verify" rest on code I read but did not run.

## 1. The model

Keep the real world and the books apart.

| Layer | What it is | Where it lives |
| --- | --- | --- |
| Real account | A place money sits: bank, cash box, wallet. Has a name, kind, UPI ID, holder | `money_account` (Money page and `/api/money/accounts`) |
| Books | The ledger account that carries that balance. Posting rules write only here | `ledger_account`, `journal_entry`, `journal_line` |
| Link | Each real account has exactly one ledger account. Its balance is that ledger account's balance | `money_account.ledger_account_id`, unique |
| Evidence | The bank statement and the gateway settlement, matched to the books | Not built (phase B) |

Rules that stay as they are: every entry balances, posted entries are immutable, closed periods refuse postings, receipts are gap-free, a record and its journal commit together.

## 2. What is done

| Area | State |
| --- | --- |
| Double-entry ledger, receipts, posting rules, UPI links, statement matching (API), gateway webhooks, finance scripts | Built (see `architecture.md` section 7) |
| Money account attaches to an existing asset ledger account (`ledgerCode`) | Built and tested. The Money page has the field and an Edit action (A1) |
| Donations creates the `upi` money account on `BANK` when the module is installed (A2) | Built (`setup.moneyAccounts` in the module manifest). Only for new installs: the module version was not raised, so an organisation that already installed Donations does not get it |
| `bank-accounts` module (`BANK_2`, `BANK_3`, bank balances report) | Removed. Forms offer `BANK` and `CASH` only |
| Migrations | Decided (H1): `001` to `006` are a squash of the old chain. `007_bank_reconciliation.sql` adds the statement tables. Schema level 7 |
| Bank reconciliation (B1, B3, B4 in part) | Built, with a screen (`/accounts/:key/reconcile`): upload a CSV (columns guessed and remembered per account, Indian dates and amounts read), review, auto-match by amount within 3 days, match, ignore with a reason, book an unmatched line, compare book lines with the statement, report the difference, sign off. Permission `money:reconcile`. Migration `007_bank_reconciliation.sql` |
| Overdraft guard (A6) | Decided: refuse, with an override reason that is recorded. Every account refuses a posting that takes it below zero unless the person gives a reason (audit action `ledger.overdraft_override`). New bank accounts default to not allowing negative; migration `012` switches existing bank accounts. Edits cannot turn it on or off while the balance is negative |
| Forms offer the organisation's real accounts (A4) | Built. A record field with `choicesFrom: moneyAccounts` lists the open money accounts and saves the ledger code; `expenses`, `earnings` and `members` use it, so a second bank needs no module change. Action forms use `choicesFrom: moneyAccounts` or `upiAccounts` (accounts with a UPI ID) and save the account key |
| Pay now account choice (A3) | Decided: the stored key stays `upi`. The donations Pay now action asks which UPI account to use (`accountFrom: input.account`, falling back to `upi`); the choice is kept on the payment (migration `013_payment_intent_account.sql`) and the receiving ledger account follows it. Schema level 13 |
| Balances as on a date (A5), account statement (A7) | Built. `GET /api/money/balances?asOf=` and the Money page balance date; `GET /api/money/accounts/:key/ledger` and the statement screen (`/accounts/:key/statement`) with running balance, source links and CSV |
| Trial balance (new) | Built. `GET /api/ledger/trial-balance?asOf=` with permission `ledger:read`, and the screen `/accounts/trial-balance`. Money, debts and funds carry forward; income and expenses are those of the financial year holding the date. Earlier years' income less expenses shows as one line, `Surplus from earlier years`, so the two columns always agree |
| Expense approval (F1) | Built. The expense claim workflow has Approve and Pay steps, and the person who submitted a claim cannot approve or pay it |
| Eight modules publish together (H5) | Permanent test `shipped-modules.test.ts` |
| Receipt layout test (H3) | Fixed (the test now completes the organisation identity first) |

Not closed by sign-off: a ledger entry can still be posted back-dated into a month that was signed off. Only the accounting period close stops that. Treat sign-off as a record of review, not a lock on the ledger, until that is joined up.

## 3. Work items

Status as of the last update: **done** H1, H3, H5, A1 to A7, B1, B3, F1 and the trial balance. **Done with a difference** B4 (unmatched lines must be booked or ignored before sign-off, which does the job of a suspense account; no suspense ledger account). **Open**: everything else. The rows below keep their original wording.

### Phase 0: repo and launch blockers

| ID | Change | Where | Done when | Size |
| --- | --- | --- | --- | --- |
| H1 | Resolve the migration state. Docs name migrations up to 029; `packages/platform/migrations/` holds `001` to `006`, and `007` to `019` show as deleted in git | `packages/platform/migrations/`, git history | Decision recorded: merged into `001` to `006`, or restored. Docs and numbering agree | S |
| H2 | Commit the finance work in reviewed pieces. The module folders are untracked | git | Modules, money-account change and docs are in history | S |
| H3 | Fix or explain the failing `receipt-layout.test.ts` (it issues a receipt with no legal name or address, which is now refused) | `tests/integration/platform/receipt-layout.test.ts` | Full finance test set green | S |
| H4 | Check Razorpay and Cashfree against their sandboxes. Webhooks are tested only with a fake HTTP client | `infrastructure/payments/providers.ts` | A paid sandbox order marks a donation Paid once, and an amount mismatch is held | M |
| H5 | Add a permanent test that all shipped modules publish together, and that every module's `dependsOn` exists | `tests/unit/platform/` | Test fails if a module names a missing dependency | S |

### Phase A: finish the bank model

| ID | Change | Where | Done when | Size |
| --- | --- | --- | --- | --- |
| A1 | Add a `ledgerCode` field to the Money page, so attaching to `BANK` needs no API call | `apps/onengo/web/src/app/money/`, `core/money/money.ts` (`OpenAccountBody`), locale strings | A person with `money:accounts:manage` opens an account on `BANK` from the page | S |
| A2 | Create the money account when a module is enabled, so attaching is not a manual step. Needs a decision on where the UPI ID comes from (organisation settings, or entered on first use) | `definition-store.ts` `installModule`, module manifest schema, `donations/module.json` | Enabling donations leaves `BANK` and `CASH` with money accounts; re-running changes nothing | M |
| A3 | Decide the key of the Pay now account. Today `upi`; renaming to `bank` means editing `pay-now.action.json` and the `s4-money` test, which probes it by key | `donations/pay-now.action.json`, `tests/integration/platform/security/s4-money.test.ts` | Decision recorded; if renamed, tests updated | S |
| A4 | Let forms offer the organisation's real accounts. "Received in" and "Paid from" are fixed choice lists today. Add a choice source that reads money accounts, then a second bank needs no module change | `recordType` schema (choice field), record engine, `expenses`, `earnings`, `members` record types | Opening a second money account makes it appear in the three forms; its posting debits its own ledger account | L |
| A5 | Bring back a balances report: bank and cash balances "as on" a date, over the organisation's money accounts. The old report listed fixed codes | `donations` (or a new report package), `report-service.ts` ledger dataset | Report lists every money account's ledger balance as on a date, and the total | M |
| A6 | Overdraft rule. Postings never check balance, and bank money accounts allow negative by default (verify). Decide: hard stop, warning, or override with a reason | `LedgerService.post`, posting rules effect, `money-account-service.ts` | A payment that would take cash or bank below zero is refused or flagged as decided | M |
| A7 | Account statement: every journal line on one account between two dates, with a running balance and the source record. I did not find one (verify) | `report-service.ts`, Money page | Opening an account shows its transactions and the closing balance matches the account balance | M |

### Phase B: make the books match the bank

| ID | Change | Where | Done when | Size |
| --- | --- | --- | --- | --- |
| B1 | Store bank statements: a statement and its lines per money account, with date, amount, text, reference and a status (`unmatched`, `matched`, `ignored`). Add an import for CSV with a saved column mapping per bank. Migration for the tables | new tables, new `application/statements/`, upload screen on the Money page | A statement uploaded twice adds no duplicate lines | L |
| B2 | Extend matching beyond UPI links. Today `matchStatement` needs the reference in the text and an exact amount. Add matches for donations, earnings, expense payments and transfers by amount, date window and text, shown as suggestions that a person accepts | `payment-service.ts` (`matchStatement`), new matching service | Suggested matches are accepted or refused; an accepted match marks the record Paid or Received through the normal step | L |
| B3 | Reconciliation per account and month: statement closing balance, ledger balance, the list of differences, and a sign-off that locks that account for the month | new service, Money page | A month with unmatched lines or a difference cannot be signed off | L |
| B4 | A suspense ledger account for unmatched lines. It must be zero before a month is signed off | `donations` setup, B3 | Suspense balance is zero at sign-off, or the sign-off is refused | S |
| B5 | Gateway settlements: import the gateway's settlement report, match each settlement to its donations, and post the fee and the net to the bank | with C1 | One settlement closes its donations and the bank line | L |

### Phase C: fees

| ID | Change | Where | Done when | Size |
| --- | --- | --- | --- | --- |
| C1 | Post the processing fee. Today the journal uses the full amount and the fee is only shown on the receipt. New ledger accounts `GATEWAY_RECEIVABLE` and `GATEWAY_FEES`. Gateway donation: Dr gateway receivable, Cr donation income, gross. Settlement: Dr bank net, Dr fees, Cr gateway receivable. UPI and cash donations unchanged | `donations/donation-paid.postingRule.json`, `donations/module.json` (bump version), `donation.recordType.json` | A gateway donation of 10,000 with a fee of 200 leaves bank 9,800 and fees 200 once settled | M |

### Phase D: funds

| ID | Change | Where | Done when | Size |
| --- | --- | --- | --- | --- |
| D1 | A fund list (unrestricted, restricted by grant or project, foreign contribution) and a fund field on donations, earnings, expenses and grants. Posting rules already accept a fund; it is unused today | new `fund` definition or table, record types, posting rules | Every income and expense journal line carries a fund | L |
| D2 | Fund balances report: opening, received, spent, closing per fund | `report-service.ts` | Fund closing balances add up to net assets | M |
| D3 | Stop a restricted fund going negative, with an override that needs a reason and a second approver | posting rule effect or `LedgerService` | Spending beyond a restricted fund is refused or flagged | M |
| D4 | Grants and pledges: money promised, then received, with the fund and any conditions | new module | A grant shows promised, received and spent | L |

### Phase E: assets

| ID | Change | Where | Done when | Size |
| --- | --- | --- | --- | --- |
| E1 | Post asset purchases and disposals. Today the register records cost and disposal but posts nothing. Purchase: Dr fixed assets, Cr bank or cash. Disposal: Dr bank, Cr fixed assets, with any gain or loss | `physical-assets` module, new posting rules and ledger accounts | Buying an asset reduces cash and raises fixed assets | M |
| E2 | Depreciation. Decide the method with your CA first. Then a monthly run that posts expense and accumulated depreciation | job, `physical-assets` | A monthly run posts balanced entries and is not repeated for the same month | L |

### Phase F: controls

| ID | Change | Where | Done when | Size |
| --- | --- | --- | --- | --- |
| F1 | An approver cannot approve their own claim. Check whether guard expressions can read the acting user; if not, add it | `expenseClaim.workflow.json`, expression scope (verify) | A claim's creator cannot run Approve or Pay on it | S |
| F2 | Approval limits by amount and role for expense payment | expenses workflow, approvals | A claim above the limit needs the senior role | M |
| F3 | A second approver to open or close a money account, and an alert on a new account | `money-account-service.ts`, approvals | Opening an account creates an approval; the audit log shows both people | M |
| F4 | Transfer matrix defaults to "allow every pair" when unset. Decide whether the default should refuse | `money-account-service.ts` (`checkMatrix`) | Decision recorded; behaviour and test match | S |

### Phase G: reports and compliance

Confirm accounting standard, 80G, FCRA and TDS rules with your CA before building.

| ID | Change | Where | Done when | Size |
| --- | --- | --- | --- | --- |
| G1 | Receipts and payments, income and expenditure, and balance sheet, with funds | `statutory-books` package, `report-service.ts` | The three statements agree with the trial balance | L |
| G2 | Year-end close: checklist, frozen opening balances, handover pack for the auditor | `architecture.md` section 7.1 lists these as not started | A closed year cannot change, and the pack opens in one download | L |
| G3 | 80G register and FCRA reports, including the designated foreign-contribution account | new reports | Each report reproduces its source receipts | L |
| G4 | TDS on payments: rate, deduction, payable and return summary | expenses, ledger accounts | A claim with TDS posts three lines and appears in the summary | L |

## 4. Order and dependencies

1. **H1 to H5 first.** The state of the repo decides what is real.
2. **A1, A5, A7, then A2 and A3.** Small, visible, and they finish the model.
3. **B1 to B4.** Reconciliation is the main gap between the books and the bank. B1 comes before the rest.
4. **C1 with B5.** The fee needs the settlement to close it.
5. **D1 to D3 before G1 and G3.** The statements and the FCRA report need funds.
6. **A4 and A6** can run alongside B; they change the engine.
7. **E and F** are independent and can be done at any point after H.

## 5. Decisions needed

1. Where the UPI ID for an automatically created bank account comes from (A2).
2. Whether the Pay now account is renamed from `upi` (A3).
3. Overdraft: hard stop, warning, or reasoned override (A6).
4. Bank statement formats to support first (B1).
5. Fund list at launch, and whether a restricted fund may go negative (D1, D3).
6. Depreciation method (E2).
7. Legal form and accounting standard, which set the statement formats (G1).
8. Approval limits by role (F2).

## 6. Risks

- **Statement formats differ** between banks and gateways. Plan time for the parsers and for manual correction.
- **Existing postings.** Changing the donation posting rule (C1) does not rewrite old entries. Posted entries are immutable; corrections are reversals.
- **Engine changes** (A4, A6, D3) touch the ledger and the record save path. Each needs tests on a real PostgreSQL before release.
- **Scope.** B and D are large. Ship B1 to B4 before starting D.
