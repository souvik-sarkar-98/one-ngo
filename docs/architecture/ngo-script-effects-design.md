# Design — Override scripts that return effects (block X1)

Status: approved, 2026-10-26, with the decisions in section 19, which override earlier sections where they differ. Block X1 of `ngo-backend-enhancement-plan.md` (section 3, Track X; brief in section 12.5). The tech lead reviews this design before X2 starts. X2 builds it, and absorbs X3 (finance-script publish audit and treasurer notification).

Published with this design:

- `schemas/scriptEffects.schema.json`: the shape a script hands back, `{ record?, effects: Effect[] }`.
- `src/scripts/effects.ts`: a pure validator that checks a script's output against that schema and the core-rule pre-checks that need no database. Tests: `test/script-effects-validation.test.ts`.

Nothing in this block changes how scripts run or save today.

## 1. Summary

A script stays a pure function. It receives a JSON copy of its input, which now includes data it declared up front (section 4). It returns two things: changed record values, where the hook allows it, and a list of **proposed effects**. The script never calls the host. The platform checks every proposal, then applies it through the engine that owns it, inside the save transaction. If any proposal is refused, or any engine refuses to apply one, the whole save rolls back. A test run shows the proposals and writes nothing.

| Effect | What it does | Applied by | Visible to the outside world |
| --- | --- | --- | --- |
| `ledger.propose` | Posts one balanced journal entry linked to the saved record | Ledger (`LedgerService.post`) with its balance, account and open-period checks, then the database triggers | At commit |
| `records.create` | Creates a record of a published type | Record engine, full save pipeline, with the permissions of the person saving | At commit |
| `notify` | Sends a published template to people | Outbox event in the save, delivered by the notification engine after commit | After commit |
| `connector.call` | Calls a declared, enabled webhook connector | Outbox event `connector.webhook` in the save, delivered by the connector engine after commit | After commit |

This follows the decision in plan section 2: "Scripts return proposed effects; the host checks and applies them in the same transaction". Host callbacks (async QuickJS) stay rejected.

## 2. As built today

- The sandbox (`src/scripts/sandbox.ts`, QuickJS WebAssembly) runs a before-save script with `ctx = { record, previous, status, recordType, user }`, plus `ctx.fail(message)` and `ctx.log(...)`. Limits: 250 ms default (10 ms to 1 s), 16 MB default (1 to 32 MB), 256 KB output, 50 log lines.
- The save pipeline (`src/runtime/records/save/`) runs in one transaction: authorize, merge, conditions, signatures, copy-from, calculate, **script**, validate, unique, rules, then write, then posting and receipt rules (`effects.ts`), then audit and outbox. The script stage rejects unknown fields and recomputes calculated fields after the scripts, so scripts cannot override them.
- Every run is logged in `script_run`. A failed run is logged after the rollback.
- `script` definitions validate against `schemas/script.schema.json`. The only hook is `beforeSave`.

## 3. Goals and non-goals

**Goals.** Scripts can propose journal entries, related records, notifications and connector calls. Every core rule still holds for every effect. The script author and the reviewer can see in the definition what a script is able to do. A test run shows exactly what a save would do.

**Non-goals.** Scripts that read data they did not declare. Scripts that call the host during the run. Effects that update or delete existing records other than the one being saved (open question 3). Ledger reversals, receipts, payments or period changes from scripts. Scheduled-job, calculated-field, report-shaping and payment-matching hooks (in the brief, no block yet). A separate approval step for finance scripts (the brief says no second approval).

## 4. The script definition (additions built in X2)

X2 extends `schemas/script.schema.json` with optional properties only. Every existing definition stays valid and means the same thing.

```json
{
  "key": "giftAidJournal",
  "recordType": "donation",
  "hook": "afterSave",
  "inputs": {
    "related": [{ "name": "donor", "field": "donor", "fields": ["name", "email", "pan"] }],
    "lookups": [{ "name": "pledges", "recordType": "pledge", "match": { "donor": "donor" }, "fields": ["amount", "status"], "limit": 5 }],
    "settings": ["organisationName", "financialYearStartMonth"]
  },
  "effects": {
    "allow": ["ledger.propose", "notify"],
    "accounts": ["1100", "4100"],
    "maxTotalAmount": "50000.00",
    "connectors": [],
    "maxEffects": 4
  },
  "code": "..."
}
```

- `hook` gains `validate`, `afterSave`, `workflowGuard` and `customButton` (section 8).
- `inputs` is the declared input list (section 5). Absent means none.
- `effects` is the declared effect policy. Absent means the script proposes nothing, which is exactly today's behaviour. `accounts` and `maxTotalAmount` are required when `allow` contains `ledger.propose`; `connectors` lists the connectors a `connector.call` may use.

Publish-time cross-reference checks (in `src/metadata/cross-refs.ts`, as for other kinds): each declared account exists and is active, each connector exists and is a webhook connector (a disabled one is a warning), each related field is a reference field of the record type, each lookup record type is published and its match and returned fields exist, each setting is on the allow-list, and each declared effect type is allowed on the hook.

## 5. Declared inputs

A script cannot look anything up during the run. Instead it declares, in its definition, what it needs. The host loads that data inside the save transaction, just before the script runs, and passes it as `ctx.inputs.<name>`.

| Input | Declares | The host loads | Limit |
| --- | --- | --- | --- |
| `related` | A reference field of the record type, and the fields wanted | The referenced record, or `null` when the field is empty, the record is gone, or the person saving cannot read it | 5 per script |
| `lookups` | A record type, an equality match from its fields to fields of the record being saved, the fields wanted, a limit | Up to `limit` matching records, newest first | 3 per script, `limit` at most 20, 50 rows in total |
| `settings` | Keys from a fixed allow-list (organisation name, financial-year start month, default currency, receipt series names) | The values | Never secrets, connector settings or credentials |

Rules for every input:

- **Permissions.** Loaded as the person saving, through the same read path as the screens: record-level rules, field visibility and masking of sensitive fields all apply. A record the person cannot read is `null`, the same as a missing one, so a script cannot probe for records it may not see.
- **Tenant.** Loaded inside the tenant transaction, so row-level security applies as for any read.
- **Size.** The whole input (record, previous, inputs) is capped at 256 KB, the same as the output. Over the cap fails the save with `script_limit`.
- **Freshness.** Inputs are read in the save transaction, so they see the same data the save does.
- **Ledger balances** are not an input in this design (open question 4).

## 6. The script contract

The harness gives the script two new things: `ctx.inputs` (read-only data, section 5) and `ctx.effects` (an empty array). The script pushes proposals onto `ctx.effects`:

```js
if (ctx.record.method === 'cash' && ctx.record.amount > 0) {
  ctx.effects.push({
    type: 'ledger.propose',
    date: ctx.record.paidOn,
    memo: 'Cash donation ' + (ctx.inputs.donor ? ctx.inputs.donor.name : ''),
    lines: [
      { account: '1100', debit: ctx.record.amount.toFixed(2) },
      { account: '4100', credit: ctx.record.amount.toFixed(2), fund: ctx.record.fund || null },
    ],
  });
  ctx.effects.push({ type: 'notify', template: 'cashDonationLogged', to: { roles: ['treasurer'] } });
}
```

The sandbox returns `{ record?, effects }`, which is what `scriptEffects.schema.json` describes:

- `record` is present only on hooks that may change the record (before save, custom button). For those it is required, as today.
- `effects` is always present, and empty when nothing was proposed.
- The 256 KB output cap covers both.

Amounts may be numbers or decimal strings. Strings such as `"1500.00"` are preferred, because they avoid floating-point surprises. Either way an amount must be positive and have at most two decimals; the validator normalises it to a two-decimal string before it reaches the ledger.

## 7. Effect types

Each proposal is checked in four layers. The first two run as soon as the script returns, before anything is written:

1. **Schema.** `scriptEffects.schema.json`. Unknown effect types and unknown properties are refused, so a script cannot set fields the host fills in (such as the source record).
2. **Pure pre-checks.** `ScriptEffectsValidator.check()`: the hook allows effects, the definition declares the effect type, account and connector, the per-run count is within the limit, journals balance, amounts are positive with at most two decimals, the journal total is within `maxTotalAmount`, a notification has a recipient. If any proposal is refused, the run returns no effects at all.
3. **Publish-time checks** on the declared policy (section 4).
4. **Engine checks at apply time**, inside the transaction, by the engine that owns the effect. The database triggers then repeat the money checks.

### 7.1 `ledger.propose`

| Field | Meaning |
| --- | --- |
| `date` | ISO date of the entry; its financial year must be open |
| `memo` | Narration, up to 200 characters |
| `lines` | 2 to 20 lines, each with `account`, exactly one of `debit` or `credit`, and an optional `fund` |

- **Pre-checks:** a real calendar date; each amount positive with at most two decimals; each account declared in `effects.accounts`; debits equal credits in whole paise; the sum of debits across all proposed journals of the run is at most `effects.maxTotalAmount`.
- **Applied by:** `LedgerService.post(tx, actor, { date, memo, sourceRecordId, sourceRule, lines })`, the same path posting rules use. The host sets `sourceRecordId` to the saved record and `sourceRule` to `script:<key>@<version>`; the script cannot set either. The ledger checks again that the entry balances, every account exists and is active, and the financial year is open. The deferred balance trigger and the closed-period trigger in the database check once more at commit.
- **Permission:** as for posting rules, the authority to post comes from the published definition, limited by its declared accounts and ceiling. The person saving needs no ledger permission, only permission to save the record. A save that is refused never posts.

### 7.2 `records.create`

| Field | Meaning |
| --- | --- |
| `recordType` | A published record type |
| `data` | Field values, up to 100 |

- **Pre-checks:** schema only.
- **Applied by:** the record engine's create path, run as a nested save inside the open transaction. X2 adds an entry point that takes the transaction, because `RecordService.create` opens its own today. The nested save runs every stage: permission (`record:<type>:create` for the person saving), field permissions, validation, unique checks, numbering, posting and receipt rules, before-save scripts of that type, audit and outbox.
- **Loops:** the nested save carries the automation depth counter (`ctx.depth`, limit 5). A script cannot create a record of its own type from that record's own save. Effects proposed by scripts inside the nested save count against the same per-save budget (section 9).

### 7.3 `notify`

| Field | Meaning |
| --- | --- |
| `template` | A published message template |
| `to` | `roles`, `users` (user ids), `creator`, and/or `field`: a person, email or phone field of the saved record |
| `channels` | `inApp`, `email`, `sms`, `whatsapp`; default in-app and email |
| `values` | Up to 20 plain values the template can show as `script.<name>` |

- **Pre-checks:** at least one recipient.
- **Applied by:** a `script.notify` outbox event written in the save transaction, delivered by the notification engine after commit, exactly as the `action.notify` event of record actions is today (`notifyOnce` in `platform.ts`). The engine checks that the template is published, the roles exist, each user belongs to the organisation and the field has the right type. It masks record fields the recipient may not see, as it does today.
- **Addresses** never come from the script. A script can name people, roles or a field of the record, but not a free email address or phone number (open question 2). This stops a script from sending data it can read to an address of its choosing.

### 7.4 `connector.call`

| Field | Meaning |
| --- | --- |
| `connector` | A connector key; must be declared in `effects.connectors` |
| `body` | Up to 50 values sent in the request body |

- **Pre-checks:** the connector is declared.
- **Applied by:** a `connector.webhook` outbox event in the save transaction, with the same `WebhookRequest` shape action steps use, and `event` set to `script.<key>`. The connector engine checks at delivery that the connector exists, is a webhook connector and is enabled by an administrator, signs the request and logs the delivery. A call is never made inside the transaction, and a failed delivery never undoes the save.
- **Network** therefore reaches only connectors an administrator has configured and enabled, and that the script names in its published definition. That matches the brief: network access is limited to connectors the administrator has approved.

## 8. Hook points (built in X2)

| Hook | Runs | May change the record | May propose effects |
| --- | --- | --- | --- |
| `beforeSave` (built) | Script stage, before validation | Yes | Yes. Pre-checked at once, applied after the write |
| `validate` | After the before-save scripts and calculated fields, inside the validate stage | No | No. It refuses with `ctx.fail(message)` |
| `afterSave` | After the write and the posting and receipt rules, inside the transaction. Sees the saved id, number and status | No | Yes |
| `workflowGuard` | When a transition is asked for, after its guard expression | No | No. It may run more than once, for example to list the steps a person can take, so it must have no effects |
| `customButton` | From a record action step `{ "type": "script", "script": "<key>" }` | Yes, saved as an update at the expected version | Yes, applied in that update's transaction |

`HOOK_OUTPUT` in `src/scripts/effects.ts` encodes this table, and the validator refuses anything else. In the database, `script_run.hook` takes the new hook names.

## 9. Ordering and limits

**Order within a save:**

1. The pre-write stages run as today. Each before-save script's proposals are pre-checked as soon as it returns, and held.
2. Validate-hook scripts run in the validate stage.
3. The record is written.
4. Posting rules, then receipt rules, run as today.
5. After-save scripts run, and their proposals are pre-checked and held.
6. The held proposals are applied: before-save proposals first, then after-save proposals; scripts in their `order`; each script's proposals in list order.
7. The audit entry and outbox event of the save, then the script-effects audit entry (section 11).
8. Commit.

**Limits:**

| Limit | Value |
| --- | --- |
| Effects per script run | `effects.maxEffects`, at most 20 (`MAX_EFFECTS_PER_RUN`) |
| Effects per save, across all scripts and nested saves | 50 (`MAX_EFFECTS_PER_SAVE`) |
| Lines per journal | 2 to 20 |
| Total journal amount per run | `effects.maxTotalAmount`, required to propose journals |
| Single amount | Up to 99,999,999,999.99, so paise sums stay exact |
| Nested save depth | The automation depth limit, 5 |
| Connector body, notification values | 50 values, 20 values; both within the 256 KB output cap |
| Declared inputs | Section 5 |

**Dry runs.** When a save runs as a dry run (`SaveContext.dryRun`), proposals are produced and pre-checked, but none is applied.

## 10. Applying in the save transaction, and rollback

- Every effect is applied with the transaction the save already holds (plan decision: one transaction per command, block D2). No effect opens a transaction or a pool connection of its own.
- Effects that touch the outside world (notifications, connector calls) are only outbox rows until commit, so a rollback leaves nothing behind.
- If a pre-check fails, the save stops before the write, with a 422 that names the script and the effect, for example `Script 'giftAidJournal' effect 1: journal does not balance: debits 1500.00, credits 1499.99`. Field issues keep the `/effects/<n>/...` path.
- If an engine refuses an effect at apply time (closed period, inactive account, no create permission, a nested validation error), the error propagates and the whole transaction rolls back: the record, its postings and receipts, other effects, audit and outbox rows. The F1 error mapping turns rule violations and database rule errors into 422, not 500.
- The failed run is logged in `script_run` after the rollback, outcome `rejected`, using the same mechanism as failed before-save scripts today (`failedScripts` in `script.ts`).

## 11. Audit and run log

- **Per run:** `script_run` gains an `effects` summary column (X2 migration): count by type and the journal total. Outcomes are `ok`, `failed`, `limit`, and the new `rejected` (a proposal was refused).
- **Per applied effect:** each engine writes its own audit as today. Journal entries carry `sourceRecordId` and `sourceRule = script:<key>@<version>`, so the ledger shows which script and version posted them. Created records are audited as `record.created` with the person saving as actor, and `causedBy` names the script.
- **Per save:** one `script.effects` audit event listing each applied effect with its script key and version, the actor and the saved record.
- **Test runs** write nothing: no audit, no run log, no outbox.

## 12. Test-run preview

The builder's Try it (`POST /api/builder/scripts/try`) shows what a save would do and writes nothing.

- It runs the script against sample values or an existing record, loads the declared inputs with the tester's permissions, and returns the field changes (as today), the logs, the proposed effects normalised by the validator, and the issues of each layer it can check without writing: schema, pre-checks, and read-only engine checks (accounts exist and are active, the financial year is open, the template is published, the connector is enabled).
- It runs in a transaction that is always rolled back, read-only where D12's `readOnly` option is available.
- Nested record creations are shown as proposals. Their own scripts and rules do not run in the preview (open question 5).

## 13. Finance-script publish audit and treasurer notification (X3, built in X2)

The brief allows any script author to publish any script, including finance scripts, with no second approval. It asks that every finance-script publish be visible in the change history and notify the treasurer.

- **A finance script** is one that declares `ledger.propose`, or whose record type has a posting rule or a receipt rule, or that belongs to a module with money record types.
- **On publish** (and on rollback, which republishes), the definition service writes the usual publish audit event plus `script.published.finance`, with the key, the version, the previous version, the author and a diff of `effects` and `code`. In the same transaction it queues a notification through the outbox to the treasurer recipients.
- **Treasurer recipients:** a setting that lists roles, by default `treasurer` where that role exists, otherwise every holder of the ledger administration permission (open question 6).

## 14. Core rules

| Core rule | How it holds for every effect |
| --- | --- |
| Every accounting entry balances | Pre-check in whole paise before the write; `LedgerService.post` checks again; the deferred balance trigger checks at commit |
| A closed period changes only through a recorded reopen | The ledger refuses a closed or missing financial year; the database trigger refuses too. Scripts cannot reopen periods |
| A receipt number is never reused or altered | Scripts have no receipt effect. Receipts come only from receipt rules, including in nested saves; the unique constraint holds |
| A balance changes only through a recorded transaction | Scripts reach balances only through `ledger.propose`, which is a journal entry with its source script and record |
| Permissions and audit always apply | Inputs are read as the person saving; records are created through the full pipeline with their permissions; every effect is audited by its engine, and the save has a `script.effects` event |
| One NGO's data is never visible to another | Everything runs in the tenant transaction under row-level security; outbox events carry the tenant; the script never sees ids outside its inputs |

## 15. Migration of existing scripts

None is needed. Existing definitions have hook `beforeSave` and no `inputs` or `effects`, so their policy allows no effects and `ctx.effects` stays empty. The harness still returns `ctx.record`, and the script stage treats it exactly as today. The new script schema properties are optional, and `test/sandbox.test.ts` must pass unchanged.

## 16. Schema publication

- `schemas/scriptEffects.schema.json`, with `$id` `scriptEffects`, follows the folder's `<id>.schema.json` naming and its description conventions.
- It is not a definition kind: nothing stores it, and `SchemaRegistry` and `DEFINITION_KINDS` are unchanged, so existing definitions validate exactly as before.
- `ScriptEffectsValidator` compiles it with the same Ajv options as `SchemaRegistry` (strict, all errors). Cursor and the import tooling can validate script outputs and test fixtures against the file directly.
- The builder's schema route (`/api/builder/schemas/:kind`) accepts definition kinds only. X2 also serves `scriptEffects` there, so the builder's Try it can show the shape.

## 17. Work for X2

1. Sandbox: `ctx.inputs` and `ctx.effects`; return `{ record?, effects }`; the input size cap; new hooks.
2. `script.schema.json`: the new hooks, `inputs` and `effects`; publish-time cross-reference checks; the finance-script rule.
3. Input loader for `related`, `lookups` and `settings`, through the read path and inside the transaction.
4. A save stage that applies the held effects after the posting and receipt rules and the after-save scripts; a record-engine create that takes the open transaction; the `script.notify` outbox handler.
5. Validate, after-save, workflow-guard and custom-button hooks.
6. Try it: effects and read-only checks, nothing written.
7. `script_run` migration (effects summary, `rejected` outcome, new hook names); the `script.effects` audit event.
8. Finance-script publish audit and treasurer notification.
9. Serve `scriptEffects` from the builder schema route.

Exit tests (plan 12.5): new `test/script-effects.test.ts`, plus existing `sandbox`, `save-pipeline`, `workflow-automation`, `record-actions` and `core-rules`. `test/script-effects-validation.test.ts` from this block stays.

## 18. Open questions for the reviewer

1. **Run-as service role.** The brief says scripts act as the person or "the declared service role they run as". This design runs every effect as the person saving. Should X2 add `runAs: <role>`, and who may publish a script that runs as a role with more rights than its users?
2. **Free addresses in `notify`.** Record actions allow an email or phone expression; this design does not let a script choose an address, to prevent data leaving to an arbitrary address. Is a record field enough, or do scripts need free addresses (for example a fixed auditor email)?
3. **Updating other records.** Only `records.create` is proposed. Is `records.update`, at an expected version and through the full pipeline, needed in the first release?
4. **Balances as input.** Should a script be able to read a ledger account or fund balance? Reading is safe, but it is the case plan section 2 names for revisiting host callbacks, because a script may want to branch on it.
5. **Preview of nested saves.** Should Try it run the nested save of a proposed record as a dry run, to show its validation and postings, at the cost of a slower preview?
6. **Treasurer recipients.** Which role or setting identifies the treasurer, and should a finance-script rollback also notify?
7. **Ceiling defaults.** Is `maxTotalAmount` per run the right control, or should there also be a per-day ceiling per script, which would need a stored running total?
8. **Effect helpers.** Raw `ctx.effects.push({...})` is enough for the schema. Should the harness add small helpers, such as `ctx.propose.journal(...)`, that build the same objects?

## 19. Review decisions (2026-10-26)

The design is approved. These answers to section 18 are part of it, and X2 builds them.

| # | Question | Decision | What X2 builds |
| --- | --- | --- | --- |
| 1 | Run as a declared service role | Yes. Only organisation administrators may publish such a script | `runAs: <role>` in the script definition. Inputs are read and effects applied with that role's permissions instead of the person saving. Publishing, or rolling back to, a version with `runAs` requires the administrator permission; anyone else gets 403. The audit names both the person saving and the role |
| 2 | Free email addresses or phone numbers in `notify` | Yes, configured by an administrator | Administrators keep a list of named fixed recipients (for example `auditor`, with an email and/or phone) in organisation settings. A script names one with `to.named: ["auditor"]`; it still cannot supply an address of its own. Unknown names are refused at publish time |
| 3 | `records.update` | Needed in the first release | `records.update` with `recordType`, `id`, `expectedVersion` and `data`, applied through the full save pipeline inside the transaction, with the same permissions as `records.create`, counted in the same budgets, and refused for the record being saved |
| 4 | Ledger or fund balances as input | Yes when needed; the administrator is responsible for the script | A `balances` input (accounts and funds, as of the save date) loaded before the run like other inputs. Only scripts published by an administrator may declare it |
| 5 | Try it runs nested saves | No | As designed: proposed records are shown, their own rules do not run in the preview |
| 6 | Treasurer recipients; notify on rollback | The organisation administrators | Finance-script publishes and finance-script rollbacks both write `script.published.finance` and notify the holders of the administrator role |
| 7 | Daily ceiling | Not now | Only the per-run `maxTotalAmount` |
| 8 | Effect helpers | Yes | `ctx.propose.journal()`, `ctx.propose.record()`, `ctx.propose.update()`, `ctx.propose.notify()` and `ctx.propose.connector()`, which push the same objects onto `ctx.effects` |
