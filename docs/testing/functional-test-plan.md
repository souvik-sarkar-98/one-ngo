# OneNGO functional test plan

| Field | Value |
| --- | --- |
| Product | OneNGO: organisation app, operator console, Builder, Donations module, public receipt, public API |
| Baseline | `develop` at commit `361d226` (merge of `features/template-html-email`), 2026-11-03 |
| Owner | QA Manager |
| Status | Draft for review |
| Supersedes | Nothing. It extends [the manual test plan](manual-test-plan.md); `MT-*` ids there stay valid and are cross-referenced here |

## 1. Purpose

This plan describes how to prove that every function OneNGO ships behaves as the code and the signed-off documents say it should. It covers the positive path, each validation rule at and around its limit, permission refusals, state-machine refusals, concurrency, isolation between organisations, and the security behaviour a user or integrator can observe.

The expected results were taken from the code at the baseline commit, not only from the documents. Where the code and a document disagree, the case says so and section 32 lists the conflict for a decision.

## 2. Product under test

| Part | Where it lives | Who uses it |
| --- | --- | --- |
| Organisation app (Angular PWA) | `apps/onengo/web`, shared controls in `packages/web-kit` | Members of an NGO: administrators, Finance, Viewer, field staff |
| Main API (Fastify) | `apps/onengo/server`, logic in `packages/platform` | The app, API-key integrations, payment-gateway webhooks, the scheduler |
| Operator console (web and API) | `apps/onengo-console` | Platform operators behind IAP with fresh multi-factor sign-in |
| Shipped content | `packages/product` (Donations module 0.2.1, schemas, six locales) | Installed into organisations at onboarding or from Builder → Modules |
| Interactive guide | `apps/onengo-guide` (served at `/guide`) | Members learning the app |
| Integration fixture | `apps/service-sandbox` | Test only: fake OIDC, Razorpay, Cashfree, SMTP, SMS, WhatsApp, webhooks, OAuth, Cloud Storage, breached-password range |

## 3. Scope

### 3.1 In scope

1. Operator console: sign-in, grants, find, onboard (validate, provision, idempotency, retry), suspend, reactivate, close, step-up.
2. Member sign-in: organisation lookup, password, email code, reset, invitation, identity provider (OIDC), two-step (TOTP), sessions, refresh, sign-out, lockout, rate limits, safe `next` redirect.
3. Shell: app bar, navigation, breadcrumb, Back, Inbox badge, sign-out confirmation, responsive layouts.
4. Home, configured pages, widgets, pins.
5. Records: groups, lists, address state, search, sort, filters, paging, the record panel, every field type and field option, workflows, approvals, sharing, actions, receipts, print, import, export, bulk, background jobs.
6. Inbox: approvals and notifications.
7. Donations module end to end: donor, donation, Mark as paid, Cancel, Send reminder, Pay now, receipt, posting, rollups.
8. Money and finance engines: financial year, receipt series, void and replacement, ledger rules, money accounts, transfers, payments, gateway configuration, webhooks.
9. Administration: setup checklist, people, roles, connectors, API keys, jobs, audit log, identity, logo, signatory, profile, registrations, settings, theme, layout.
10. Settings (More): profile, language, two-step state, install app, guide, About.
11. Builder: catalogue, editor frame, every definition kind, check, publish, discard, history, rollback, extension patches, modules, access map, translations, expression editor.
12. Runtime engines: automations and scheduler, outbox and connectors (send, lookup, OAuth), override scripts, notifications and templates (including HTML email).
13. Privacy: consent and erasure through the API.
14. Languages and fallback, PWA and offline, accessibility behaviour, tenant isolation, user-visible security behaviour, health and readiness, data export.

### 3.2 Out of scope, or held for another pass

| Item | Reason |
| --- | --- |
| Passkey sign-in | Only on the unmerged branch `features/passkey-authentication`. Section 33 holds a ready-to-run block for when it merges. |
| Configuration packages (`.onengo-config`, R2-B02) | Planned, not built. |
| Privacy screens and the Builder "personal" switch | Not built. Privacy is tested through the API only (section 22). |
| Payment page in the web app (`/payments/<id>`) | Not built; open product question. |
| Live gateway charges | Use the integration fixture or a provider sandbox only. |
| Load, stress, soak, cold-start budgets | Non-functional pass. FT-OPS-008 lists the budgets that pass should measure. |
| Penetration testing, dependency audit, cloud IAM | Security pass. This plan covers only the security behaviour a functional tester can observe. |
| Automated unit and contract tests in `packages/*/test` | Already in CI; this plan does not repeat them. |

## 4. References

| Document | Used for |
| --- | --- |
| `docs/testing/manual-test-plan.md` | Existing manual cases `MT-*` |
| `docs/product-briefs/ngo-management-platform.md` | Product goals and the six core rules |
| `docs/design/ngo-app-ui-design.md` | Screen behaviour and the address contract |
| `docs/user-guide/index.html` | User-facing wording |
| `docs/business/**/business-document.html` | Payment gateway, financial year, organisation, override script, consent and erasure, person |
| `docs/plans/ngo-release-1-build-blocks.md`, `ngo-release-2-build-blocks.md` | Block-level rules |
| `docs/reports/s4-review-2026-10-26.md` | Security findings S4-1 to S4-17 |
| `docs/reports/ui-ux-audit-2026-11-01.md` | UX-001 to UX-015 |
| `docs/architecture/connector-runtime.html`, `ngo-script-effects-design.md` | Connector and script runtime |
| `docs/operations/devops-handover.md`, `docs/operations/monitoring/` | Webhooks, alerts, start-up checks |
| `packages/product/modules/donations/*.json`, `packages/product/schemas/*.schema.json` | Module and definition limits |

## 5. Test approach

### 5.1 Levels and kinds

| Level | What it means here | How |
| --- | --- | --- |
| UI functional | A person uses the organisation app or the operator console | Browser, phone width (below 760 px) and desktop width (1100 px and up); tablet (760–1099 px) for layout cases only |
| API functional | An integrator or the app calls the API | HTTP client (curl, Postman, Bruno) with a bearer token or `Authorization: ApiKey <id>.<secret>` |
| End-to-end journey | One business process across roles, screens, mail, and the operator console | Section 30 |
| Exploratory | Time-boxed charters | Section 31 |

### 5.2 Design techniques

- **Boundary values.** Every numeric or length limit is tested at the limit, one below, and one above (for example a 500-character reason passes, 501 fails).
- **Equivalence classes.** Each field format gets one valid value and one value from each invalid class.
- **State transitions.** Organisation lifecycle, onboarding steps, donation workflow, approval requests, jobs, imports, payment intents, connector deliveries.
- **Decision tables.** Permissions (role × area × action) and field visibility (`readPermission`, `editPermission`, `visibleWhen`, `editableWhen`).
- **Error guessing.** Double submit, stale versions, back button, reload mid-flow, two tabs, two users.
- **Negative security.** Cross-organisation ids, unauthenticated calls, forged signatures, replayed tokens.

### 5.3 Case format

Every case has an id, a priority, a type, steps, and the expected result.

- **Id:** `FT-<AREA>-<nnn>`. Where a case refines an existing manual case, the `MT-*` id is shown in brackets.
- **Priority:**
  - **P0:** money, identity, isolation, or data loss. A failure stops the release.
  - **P1:** a main feature or a rule a user relies on.
  - **P2:** wording, layout, or a rare path.
- **Type:**
  - **Pos:** positive path.
  - **Neg:** refusal path.
  - **Bnd:** boundary value.
  - **Sec:** security behaviour.
  - **Con:** concurrency.
  - **UI:** layout or accessibility.
  - **API:** called through the API.

"Error `x`" in an expected result means the API returns error code `x` in the JSON envelope `{code, message, issues?}` with the matching status: `400 bad_request`, `403 forbidden`, `404 not_found`, `409 conflict`, `422 validation_failed | rule_violation | definition_invalid | script_failed | script_limit`, `429 rate_limited`, `500 internal`. On screen, the same failure shows as a message under the field or in a notice.

## 6. Environments

| Environment | Use |
| --- | --- |
| Local (`npm run dev`) | Main API on `http://localhost:8080`, web on `http://localhost:4200`, integration fixture with fake providers and SMTP. Seeds Demo Foundation and Harbour Relief. Good for every case that needs a fake gateway, OIDC, mail, or webhook. |
| Shared test | Deployed main and operator services, real mailbox, provider sandboxes, IAP. Needed for the operator console and for alerts. |
| Release candidate | Smoke (section 34.1) and the release gates. |

**Browsers:**
- Chromium (Chrome or Edge) on desktop.
- Chrome on Android.
- Safari on iOS, for install, safe-area, and keyboard cases.
- Firefox on desktop for a sample of the UI cases.

**Record for each run:**
- Organisation app address and operator console address.
- Version from **Settings → About this app**.
- Browser and viewport.
- Schema level.
- Tester and date.

## 7. Accounts, roles and test data

### 7.1 Personas

| Persona | Organisation | Roles or grants | Used for |
| --- | --- | --- | --- |
| OP-FULL | Platform | Operator grants onboard, status, retry, suspend, reactivate, close | Console |
| OP-LOOK | Platform | Grant `status` only | Console refusals |
| OP-NONE | Platform | Operator account with no grants; also a disabled account | Console refusals |
| ADMIN | Riverbank (A) | `admin` (all permissions `*`) | Everything |
| FIN | A | Donations Finance | Money, donations |
| VIEW | A | Donations Viewer | Read-only checks |
| PEOPLE-ADMIN | A | Custom role with `members:manage` only | Administration scoping |
| ROLES-ADMIN | A | Custom role with `admin:roles` only | Role management |
| CONFIG | A | Custom role with `config:read`, `config:publish` | Builder without admin |
| SCRIPT | A | `config:script:publish` without `config:script:admin` | Script restrictions |
| DIR | A | Custom role with `people:read` only | Confirms the people directory is not offered outside Administration |
| NOACCESS | A | Role with no permissions | Empty Home, refusals |
| TWOSTEP-ON | A | Any role, authenticator enrolled | Two-step sign-in |
| TWOSTEP-REQ | A | Role with `requireTwoStep`, no authenticator | Two-step refusal |
| PRIV | A | `privacy:consent:record`, `privacy:consent:read`, `privacy:erase` | Privacy API |
| B-ADMIN | Harbour (B) | `admin` in a second organisation | Isolation |
| SHARED | A and B | Member of both organisations with one account | Isolation, erasure of shared accounts |
| API-VIEW | A | API key acting as Viewer | API |
| API-FIN | A | API key acting as Finance | API writes |

### 7.2 Data

The loaded accounts, roles, donors, and donations are in [functional-test-data.md](functional-test-data.md).

**Onboarding request:** use the Riverbank request in the manual test plan, section 4, with a fresh `requestId` each run.

**Donors:**
- `ABCDE1234F` Ravi Kumar, with email and phone.
- A donor without PAN.
- A donor with a 200-character name.

**Donations:**
- Raised 1000 with fee 10.
- Raised 1.
- Raised 99,999,999.99.
- Paid by cash, bank transfer, UPI, cheque, and online gateway.
- Cancelled.

**Files:**
- PNG, JPEG, and WebP images under 1 MB.
- An image of 1 MB + 1 byte.
- A GIF.
- An SVG.
- A PDF.
- A .docx and a .xlsx.
- A .exe renamed to .pdf.
- A 25 MB file, and a 25 MB + 1 byte file.
- A PNG signature of 200 KB and one of 201 KB.

**CSV:**
- A valid 2-row file.
- A file with one bad row.
- An empty file, and a header-only file.
- A file with duplicate column names.
- A 10 MB + 1 byte file.
- A file with 20,001 rows.
- A file with values starting `=`, `+`, `-`, `@` (formula-injection check on export).
- Indian-format amounts `1,00,000.50`, `₹ 500`, `Rs 20`, `INR 5`.
- Dates in `31/03/2027` and `2027-03-31`.

**Text:**
- Hindi, Tamil, Telugu, Bengali, and Marathi samples.
- An emoji.
- A right-to-left sample.
- HTML and script payloads: `<script>alert(1)</script>`, `<img src=x onerror=alert(1)>`, `javascript:alert(1)`.

### 7.3 Mail and providers

**Mail:**
- Locally the fixture SMTP keeps the last 200 messages.
- On shared test, use a real mailbox.
- Email falls back from the organisation's own HTTP email sender, to its SMTP connector, to the installation's mail (OneNGO's email service). An organisation with no connector still sends, through the installation's mail; only an installation with no mail either sends nothing. Plan the no-mail cases accordingly.
- If mail is unavailable, every case that reads a message is **Blocked**, not Pass.

**Fixture providers:**
- Razorpay: INR only, amount at least 100 paise.
- Cashfree: INR only, amount at least 1.
- Breached-password check: only the literal `password` is reported breached.

## 8. Entry, exit, suspension

| Gate | Rule |
| --- | --- |
| Entry | Build deployed; `/health` 200 and `/ready` 200; migrations at the expected schema level; Donations module published; mail reachable or the mail cases marked Blocked; test accounts in section 7 created |
| Suspend testing | Any P0 smoke case fails; data from one organisation is visible in another; the environment resets data mid-run |
| Resume | The blocking defect is fixed and redeployed, and smoke passes again |
| Exit, wider release | Every P0 is Pass; every P1 Fail has an accepted workaround or fix; every Blocked case names its missing precondition; every open item in section 32 has a decision |
| Exit, Donations release | Every P0 in sections 10, 11, 16, and 17 passes on an organisation with the module |

## 9. Defects

| Severity | Examples |
| --- | --- |
| Blocker | Cross-organisation data visible; a receipt number is repeated, skipped, or altered; an unbalanced journal is posted; a closed year changes; a revoked key or ended session still works; suspend or close deletes data; a sign-in bypass |
| Critical | A P0 case fails with no safe workaround |
| Major | A P1 case fails, or a P0 case fails with a workaround |
| Minor | Wording, layout, P2 |

**What every defect must include:**
- The case id.
- The persona.
- The organisation code.
- The `x-request-id` header from the failing response, when there is one.
- A screenshot, or the request and response.

---

## 10. Operator console (`OPC`)

Preconditions: the public console address and an identity provider that reports `amr` and `auth_time`. Two-factor authentication is required on every sign-in. Locally, use the fixture OIDC.

### 10.1 Access and sign-in

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-OPC-001 [MT-OP-01] | P0 | Pos | As OP-FULL open the console, choose **Continue to identity provider**, complete sign-in with a fresh multi-factor check | Find screen opens. Session cookie `__Host-ngo_operator` is HttpOnly, Secure, SameSite=Strict. The organisation-app session, if any, is unchanged |
| FT-OPC-002 | P0 | Sec | Call a console API route with no session cookie | Refused with `An active operator session is required.` |
| FT-OPC-003 | P1 | Pos | Open the public console address while signed out | The page title is One NGO Console and the sign-in page says two-factor authentication is required |
| FT-OPC-004 [MT-OP-02] | P0 | Neg | Sign in with a token whose `amr` lacks `mfa` | `The identity provider did not prove multi-factor authentication.` No session |
| FT-OPC-005 | P0 | Bnd | Sign in with `auth_time` 4 min 59 s old, then 5 min 1 s old | First succeeds. Second: `Fresh operator authentication is required.` |
| FT-OPC-006 | P1 | Bnd | Token with `auth_time` 61 s in the future | Refused as not fresh |
| FT-OPC-007 | P1 | Neg | With `OPERATOR_OIDC_MFA_ACR` set, sign in with a token whose `acr` differs | `The required operator assurance level was not met.` |
| FT-OPC-008 | P1 | Sec | Start sign-in, wait more than 10 minutes, finish at the provider | Login state expired; sign-in must restart |
| FT-OPC-009 | P1 | Sec | Replay the same callback URL (state) a second time | Refused; state is one-use |
| FT-OPC-010 | P1 | Neg | Sign in as a disabled operator account | No session is created |
| FT-OPC-011 | P1 | Sec | Disable an operator who is signed in (grant CLI `disable`) | Their open sessions are revoked on the next request |
| FT-OPC-012 | P1 | Bnd | Stay signed in more than 8 hours | Session expires; protected routes return to sign-in |
| FT-OPC-013 | P1 | Sec | Trigger back-channel logout from the provider for this session's SID | Session revoked |
| FT-OPC-014 [MT-OP-16] | P1 | Pos | Sign out, then press Back | Protected pages return to sign-in |
| FT-OPC-015 | P0 | Sec | Send a mutating console request (onboard, suspend) without the CSRF token | Refused |
| FT-OPC-016 | P0 | Sec | Call the console API with a member access token from the organisation app, and call the main API with the operator cookie | Both refused |
| FT-OPC-017 | P1 | Sec | Look for list or bulk organisation routes (`/organisations`, a search with a wildcard) | No list exists. Only exact find by code or request id |

### 10.2 Grants

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-OPC-020 [MT-OP-03] | P0 | Neg | As OP-LOOK find an active organisation | Status shown; Suspend, Reactivate, Close, Retry, and Onboard are absent |
| FT-OPC-021 [MT-LIFE-11] | P0 | Sec | As OP-LOOK, call suspend, reactivate, close, retry, and onboard directly | Each refused with `The <action> grant is required.` |
| FT-OPC-022 | P1 | Neg | As OP-NONE, open Find | `The status grant is required.` |
| FT-OPC-023 | P1 | Pos | Grant then revoke `retry` with the grant CLI; repeat a retry each time | Allowed after grant, refused after revoke. Each grant change is in the platform audit |
| FT-OPC-024 | P1 | Sec | Try to update or delete a `platform_audit` row from the database runtime login | `platform audit entries cannot be changed or deleted` |

### 10.3 Find and status

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-OPC-030 [MT-OP-04] | P1 | Neg | Find an unknown code, then an unknown request id | `There is no such organisation or onboarding request.` |
| FT-OPC-031 | P1 | Neg | Call find with both `code` and `requestId`, then with neither | `Provide exactly one code or requestId.` |
| FT-OPC-032 | P1 | Pos | Find an organisation that has more than 50 history entries | History newest first, at most 50 entries, including provisioning and lifecycle events |
| FT-OPC-033 | P2 | Pos | Find by code in upper case | Behaviour recorded; codes are lower case, so expect not found or a normalised match. Note which |

### 10.4 Onboard: validation (one broken rule per draft)

Start from the valid Riverbank request each time. Validation must name the broken field and keep **Provision** unavailable. Validate-only writes nothing: Find by that code still says no such organisation.

| ID | Pri | Type | Field and value | Expected |
| --- | --- | --- | --- | --- |
| FT-OPC-040 [MT-OP-05] | P0 | Pos | Valid request | Status `valid`, step `none`. Provision enabled. Nothing written |
| FT-OPC-041 | P1 | Bnd | `requestId` of 2, 3, 100, 101 characters | 2 and 101 refused; 3 and 100 accepted |
| FT-OPC-042 | P1 | Neg | `requestId` starting with `.` or containing a space or `/` | Refused (`[A-Za-z0-9][A-Za-z0-9._:-]{2,99}`) |
| FT-OPC-043 | P0 | Bnd | `code` `ab` (2), `abc` (3), 40 chars, 41 chars | 2 and 41 refused; 3 and 40 accepted |
| FT-OPC-044 | P1 | Neg | `code` `RiverBank`, `-river`, `river-`, `river--bank`, `1river`, `river_bank` | Each refused |
| FT-OPC-045 [MT-OP-11] | P1 | Neg | Each reserved code: `admin`, `api`, `app`, `internal`, `onengo`, `operator`, `sign-in`, `support`, `www` | Each refused as reserved |
| FT-OPC-046 | P1 | Neg | `code` already used by another organisation | Refused as taken |
| FT-OPC-047 | P1 | Bnd | `displayName` 120 and 121 chars; `legalName` 200 and 201; administrator name 120 and 121 | Over-limit values refused |
| FT-OPC-048 | P1 | Neg | Administrator email `asha@`, `asha.example`, and 255 characters | Refused |
| FT-OPC-049 | P1 | Neg | Contact phone `12345` (5), `+91 (80) 4000-1200`, 21 characters, letters | 5, 21, and letters refused; the bracketed form accepted |
| FT-OPC-050 | P1 | Neg | Country `India`, `in`, `IND` | Refused; `IN` accepted |
| FT-OPC-051 | P1 | Neg | Time zone `Kolkata`, `IST`, `UTC+5:30` | Refused; `Asia/Kolkata` accepted |
| FT-OPC-052 | P1 | Neg | Default language `fr`, `EN`, `hi-IN` | Refused; `en`, `hi`, `ta`, `te`, `bn`, `mr` accepted |
| FT-OPC-053 | P2 | Neg | Region `Asia-South1`, `1asia`, 41 characters | Refused |
| FT-OPC-054 | P1 | Neg | Financial year `2026` with start month 4; `2026-27` with start month 1; start month 0 and 13 | Each refused. `2026` with month 1 and `2026-27` with month 4 accepted |
| FT-OPC-055 | P1 | Bnd | Receipt prefix `rcpt`, `RC/PT`, `-RCPT`, 12 and 13 characters | `rcpt`, `/`, leading dash, and 13 refused; 12 accepted |
| FT-OPC-056 [MT-OP-13] | P1 | Neg | Receipt prefix with an empty module list | Refused: no module issues receipts |
| FT-OPC-057 | P1 | Bnd | 20 registrations, then 21 | 21 refused |
| FT-OPC-058 | P1 | Neg | Two registrations with the same type and number (one in lower case) | Refused as duplicate |
| FT-OPC-059 | P1 | Neg | Module list with an unknown key, a duplicate key, 21 entries | Each refused |
| FT-OPC-060 [MT-OP-12] | P2 | Neg | A module whose dependency is missing (skip if no shipped module has one) | Names the missing dependency |
| FT-OPC-061 | P1 | Sec | Validation response for a request with registration numbers | Problems listed per field; registration numbers are not echoed back |
| FT-OPC-062 | P1 | Neg | Request body includes a password field | Refused (unknown property) |
| FT-OPC-063 [MT-OP-15] | P1 | UI | Validate, edit one character, try Provision | Provision is disabled until Validate succeeds on the edited text |
| FT-OPC-064 | P2 | Neg | Paste invalid JSON | Clear parse error; Provision disabled |

### 10.5 Onboard: provision, idempotency, retry

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-OPC-070 [MT-OP-07, MT-OP-08] | P0 | Pos | Provision the valid request | Result shows code and request id. Status Active. Profile, registrations, `admin` role (permission `*`), Finance and Viewer roles, Donations accounts `BANK`, `CASH`, `DONATION_INCOME`, receipt series with the given prefix, open financial year, administrator invited. The invitation mail arrives only after the organisation is Active |
| FT-OPC-071 [MT-OP-09] | P0 | Pos | Submit the same request id and identical body again | The same organisation is returned. No second organisation, no second invitation |
| FT-OPC-072 [MT-OP-10] | P0 | Neg | Same request id, different legal name | `Request <id> was already used for a different onboarding request.` Stored organisation unchanged |
| FT-OPC-073 | P1 | Pos | Onboard with an administrator email that already has an account in another organisation | That account is reused; name and password unchanged; it gets `admin` only in the new organisation |
| FT-OPC-074 [MT-OP-14] | P1 | Pos | Make provisioning fail mid-way (for example mail down at the administrator step), then **Retry failed work** | Status Provisioning failed with the step. Retry resumes from the last finished step. Step order: requested, tenant, profile, administrator-role, modules, receipt-prefix, fiscal-year, administrator, readiness, active. No duplicate data |
| FT-OPC-075 | P1 | Pos | Organisation became Active but the invitation failed; Retry | `The invitation could not be sent.` was recorded; Retry sends the invitation only |
| FT-OPC-076 | P1 | Neg | Retry on an organisation that is already Active with nothing failed | No change; no second invitation |
| FT-OPC-077 | P1 | Neg | Sign in as the new administrator before the organisation is Active (during provisioning) | `This organisation is not available for sign-in.` |
| FT-OPC-078 | P1 | Con | Submit the same new request twice at the same moment (two tabs) | Exactly one organisation is created |

### 10.6 Lifecycle and step-up

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-OPC-080 [MT-LIFE-01] | P0 | Pos | Active organisation → Suspend → complete fresh MFA → enter reason → Suspend again | Status Suspended; reason in history |
| FT-OPC-081 [MT-LIFE-02] | P0 | Pos | After suspend: member signs in; API key used; refresh token used; open app tab acts | Sign-in refused; key refused; refresh refused; open tab is signed out on its next call |
| FT-OPC-082 | P0 | Pos | After suspend, call a public receipt link and the sign-in lookup | Lookup returns the uniform not-available answer. Record whether the public receipt link still opens, and file it if it does |
| FT-OPC-083 [MT-LIFE-04] | P1 | Bnd | Reason of 500 characters, of 501, of only spaces, empty | 500 accepted (trimmed); 501 `The reason is at most 500 characters.`; blank `Give the reason, which is kept in the audit.` |
| FT-OPC-084 [MT-LIFE-03] | P2 | UI | Choose Suspend, return from the step-up | The reason field is empty and is typed after the check |
| FT-OPC-085 [MT-LIFE-06, MT-LIFE-07] | P0 | Pos | Reactivate with step-up, reason empty | Active. Old sessions stay ended; old revoked keys stay revoked; a fresh sign-in and a new key work |
| FT-OPC-086 [MT-LIFE-05] | P1 | Neg | Suspend a Suspended organisation; Reactivate an Active one; Close an Active one | `Only an active organisation can be suspended. This one is suspended.`; `Only a suspended organisation can be reactivated. This one is active.`; `Suspend the organisation before closing it. This one is active.` |
| FT-OPC-087 [MT-LIFE-08, MT-LIFE-09] | P0 | Pos | Close a Suspended organisation with reason | Closed. Sign-in refused. Reactivate not offered and refused by API. Find still shows the organisation. Records remain in the database |
| FT-OPC-088 | P1 | Pos | Close an organisation in Provisioning failed | Closed |
| FT-OPC-089 | P1 | Neg | Try to reactivate or suspend a Closed organisation | Refused; Closed is permanent |
| FT-OPC-090 [MT-LIFE-10] | P0 | Sec | Use one step-up for Suspend on org A to try Close on A, then Suspend on org B | Both refused: `A fresh, one-use MFA step-up is required.` |
| FT-OPC-091 | P0 | Sec | Reuse a step-up that was already used | Refused |
| FT-OPC-092 | P1 | Bnd | Complete step-up and wait 5 min 1 s before confirming | Refused; step-up expired |
| FT-OPC-093 | P1 | Sec | Complete step-up as a different identity from the console session | Refused |
| FT-OPC-094 | P1 | Pos | Read platform audit after each lifecycle action | Entry with operator, action, organisation, reason, time |

## 11. Member sign-in and identity (`AUTH`)

### 11.1 Organisation lookup and sign-in pages

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-AUTH-001 | P0 | Pos | Open `/sign-in` on a fresh browser | "Sign in using organisation code", a code field, Continue, and the hint "Use the code from your invitation or administrator. OneNGO does not list organisations." |
| FT-AUTH-002 | P1 | Neg | Enter `  RiverBank ` | Trimmed and lower-cased; opens `/o/riverbank/sign-in` |
| FT-AUTH-003 | P2 | Neg | Enter an empty code, `-x`, `a_b`, 41 characters | Nothing happens; no request sent (pattern `^[a-z0-9][a-z0-9-]{0,39}$`). Record that no message is shown (minor UX) |
| FT-AUTH-004 [MT-AUTH-09] | P0 | Sec | Open `/o/<code>/sign-in` for an unknown code, a provisioning org, a Provisioning failed org, a Suspended org, and a Closed org | All show "This organisation is not available for sign-in." with tab title "Sign in \| OneNGO". The API returns the same 404 for each, with similar response time (at least 150 ms) |
| FT-AUTH-005 [MT-AUTH-10] | P1 | Pos | Open an active organisation's page with a logo set | Product mark, organisation display name, logo, organisation theme colours, title "<display name> \| OneNGO". No code field |
| FT-AUTH-006 | P2 | Pos | Same, with no logo | No logo and no generated initials |
| FT-AUTH-007 [MT-AUTH-11] | P1 | Pos | Sign in through the generic page, sign out, open `/sign-in` | Redirected to the last organisation's page |
| FT-AUTH-008 [MT-AUTH-12] | P1 | Pos | Choose **Use another organisation** | Memory cleared; generic page with an empty field (`/sign-in?another`) |
| FT-AUTH-009 | P1 | Sec | Make more than 20 organisation lookups per minute from one address | `429 rate_limited` with `retry-after: 60` |
| FT-AUTH-010 | P2 | Pos | `?message=` of 400 characters | Shown as an error, cut to 300 characters; removed from the address after load |

### 11.2 Password sign-in, policy, lockout

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-AUTH-020 [MT-AUTH-07] | P0 | Pos | Password tab, correct email and password | Home opens. Navigation shows only allowed places. Access token in memory only (not in localStorage); refresh cookie `ngo_rt` HttpOnly, Secure, `Path=/api/auth`, 30 days |
| FT-AUTH-021 [MT-AUTH-08] | P0 | Neg | Correct email, wrong password; unknown email | Both "Sign-in failed. Check your details and try again." Same message, similar timing |
| FT-AUTH-022 | P0 | Sec | Five wrong passwords for one email, then the right password | After the 5th failure, sign-in locked for 15 minutes: "Too many attempts. Try again in a few minutes, sign in with a code sent to your email, or reset your password." Right password refused while locked |
| FT-AUTH-023 | P1 | Pos | While password-locked, sign in with an email code | Succeeds and clears the lock (S4-13) |
| FT-AUTH-024 | P1 | Pos | While locked, complete a password reset | Lock cleared; new password works |
| FT-AUTH-025 | P1 | Sec | 20 failures from one address across different emails | Address locked; other addresses unaffected |
| FT-AUTH-026 | P1 | Sec | More than 30 `/api/auth/*` requests per minute from one address | `429 rate_limited` |
| FT-AUTH-027 | P1 | Neg | Sign in to org B with an account that is a member only of org A | Refused with the generic message |
| FT-AUTH-028 | P1 | Neg | Suspended member signs in | Refused |
| FT-AUTH-029 | P1 | Neg | Password sign-in when the organisation turned password sign-in off | "Password sign-in is not available…" |
| FT-AUTH-030 | P2 | UI | Submit with Enter; double-click Sign in | One request; button disabled while it runs |

**Password policy** (applies to reset and invitation). Test each value on the reset page:

| ID | Pri | Type | Value | Expected |
| --- | --- | --- | --- | --- |
| FT-AUTH-040 [MT-AUTH-04] | P1 | Bnd | 9 characters / 10 characters / 200 / 201 | 9: "Use at least 10 characters." 10 and 200 accepted if otherwise strong; 201: "Password is too long." |
| FT-AUTH-041 [MT-AUTH-05] | P1 | Neg | `password1234`, `abcdefghij`, `1111111111`, `qwertyuiop`, `abcabcabca` | "This password is too easy to guess…" |
| FT-AUTH-042 [MT-AUTH-06] | P1 | Neg | `ashamenon12`, `riverbank99x`, the email local part plus 5 characters | "Do not build your password around your name, email, or organisation." |
| FT-AUTH-043 | P1 | Bnd | Name plus exactly 6 other characters | Accepted |
| FT-AUTH-044 | P2 | Neg | `password` with the breached-password check on (fixture) | "…has appeared in a data breach…" |
| FT-AUTH-045 | P2 | Pos | Breached-password service unreachable | Check skipped; a strong password is accepted |
| FT-AUTH-046 | P1 | Neg | Two fields differ | "The two passwords do not match." No request sent |

### 11.3 Email code

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-AUTH-050 [MT-AUTH-13] | P1 | Pos | Email code tab, member email, Email me a code, enter 6-digit code | "If that address belongs to a member, a code is on its way. It expires in 10 minutes." Sign-in opens Home |
| FT-AUTH-051 [MT-AUTH-14] | P0 | Sec | Request for a non-member and for a member | Same `202` message both times; only the member gets mail |
| FT-AUTH-052 [MT-AUTH-15] | P1 | Bnd | Use the code at 9 min 50 s and at 10 min 10 s | First works; second refused |
| FT-AUTH-053 | P1 | Sec | Use the same code twice | Second refused |
| FT-AUTH-054 | P1 | Sec | Enter 5 wrong codes, then the right one | Code exhausted after 5 attempts; email-code lock: "Too many attempts. Try again in a few minutes, or reset your password." |
| FT-AUTH-055 | P1 | Sec | Request 4 codes for one email within 15 minutes | The 4th is silently not sent (still `202`). Only codes 1–3 arrive |
| FT-AUTH-056 | P2 | Sec | Request 11 codes from one address across emails in 15 minutes | Requests after the 10th are silently not sent |
| FT-AUTH-057 | P2 | UI | Switch tab between Password and Email code | Email kept; messages cleared |
| FT-AUTH-058 | P1 | Neg | Code of 5 digits, letters | Field accepts at most 6 digits; server refuses malformed code |

### 11.4 Password reset and invitation

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-AUTH-060 [MT-AUTH-16] | P0 | Pos | Forgot password → email → open link → new password twice → save → sign in | Notice: "…a reset link is on its way. It works once and expires in 30 minutes." New password works; old does not. "Go to sign in" opens `/o/<code>/sign-in` |
| FT-AUTH-061 [MT-AUTH-17] | P0 | Sec | Open the used link again; open a link 31 minutes old | Both: "This link has expired or has already been used…" |
| FT-AUTH-062 [MT-AUTH-18] | P0 | Sec | Signed in on device 2; reset on device 1 | Device 2 signed out on its next call (access token refused, refresh refused) |
| FT-AUTH-063 | P1 | Pos | Reset token is removed from the address bar after load | Address shows no token; reload says "This link is incomplete. Ask for a new one." |
| FT-AUTH-064 | P1 | Sec | Request 4 resets for one email in 15 minutes | Only 3 mails sent; every response says the same |
| FT-AUTH-065 [MT-AUTH-01] | P0 | Pos | Open an invitation (`kind=invite`) and set a password | Title "Set your password". After save, sign-in works |
| FT-AUTH-066 [MT-AUTH-02] | P0 | Sec | Open the same invitation again | Refused as used |
| FT-AUTH-067 [MT-AUTH-03] | P1 | Bnd | Invitation 6 days 23 hours old; 7 days 1 hour old | First works; second refused |
| FT-AUTH-068 [MT-PPL-04] | P1 | Sec | Resend an invitation; open the first link, then the second | First refused; second works |
| FT-AUTH-069 | P2 | Pos | Invitation sent with organisation default language Hindi | Mail in Hindi |
| FT-AUTH-070 | P2 | Neg | Invitation subject wording | Record actual subject; documented gap: lacks "on OneNGO" |

### 11.5 Identity provider and two-step

Preconditions: the provider is offered only after an operator holding the `sign_in` grant switches it on for the organisation in the operator console (`/organisations/sign-in?code=…`): **Verify to make a change** for a fresh step-up, a reason for the audit, **Offered on the sign-in page**, **Save opt-in**. One change per step-up. The organisation's own Sign-in methods page is read-only by design. Locally the provider is the fixture OIDC; its certificate is signed by the fixture's local CA (`ca.crt`), trusted by the server through `NODE_EXTRA_CA_CERTS` but not by a browser, so install that CA in the browser trust store for a browser run.

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-AUTH-080 [MT-AUTH-19] | P1 | Pos | After the console opt-in, "Sign in with {provider}" as an existing member | Home opens; the button sits outside the Password/Email code tabs |
| FT-AUTH-081 [MT-AUTH-20] | P0 | Sec | After the console opt-in, provider sign-in as a person who is not a member | No member created; returns to sign-in with a message |
| FT-AUTH-082 | P1 | Neg | Provider returns `error=access_denied` | Back on sign-in with a message, no session |
| FT-AUTH-083 | P1 | Sec | Tamper with `state` on the callback | Refused |
| FT-AUTH-084 | P1 | Pos | Provider sign-in for a member with two-step on | Redirected with `ticket`; authenticator step shown: "Enter the code from your authenticator app to finish signing in." Provider buttons hidden |
| FT-AUTH-085 [MT-AUTH-23] | P2 | Bnd | Wait 5 min 1 s before entering the code | Ticket expired; start again |
| FT-AUTH-086 [MT-AUTH-22] | P1 | Pos | TWOSTEP-ON: password, then current code; then wrong code | Current code opens Home; wrong refused; Settings shows two-step On |
| FT-AUTH-087 | P1 | Sec | Reuse a code from the same 30-second step on a second sign-in | Refused (S4-11) |
| FT-AUTH-088 [MT-AUTH-21] | P0 | Neg | TWOSTEP-REQ signs in | "Your role requires two-step sign-in. Ask an administrator to help you set it up." No QR screen |
| FT-AUTH-089 | P1 | API | `POST /api/auth/two-step/begin` with no existing TOTP; then `confirm` with the right code | Secret and `otpauth` URL returned; confirm `204`; two-step now On |
| FT-AUTH-090 | P0 | Sec | `begin` when TOTP exists, without password or code; with password only | `422`. Old authenticator keeps working (S4-3) |
| FT-AUTH-091 | P1 | Sec | Two `begin` calls; confirm the first secret | Only the newest setup can be confirmed |
| FT-AUTH-092 | P2 | Pos | Authenticator label | Record actual label; documented gap: reads "NGO Platform:<email>" |

### 11.6 Sessions, tokens, redirect

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-AUTH-100 [MT-AUTH-24] | P0 | Pos | Signed in on two devices; sign out on one (confirm dialog) | That device returns to sign-in; the other stays signed in |
| FT-AUTH-101 | P1 | Pos | Leave the app idle beyond 15 minutes then act | Access token refreshed silently through the cookie; action succeeds |
| FT-AUTH-102 | P0 | Sec | Replay an old (rotated) refresh cookie | `403`; the whole session family ends: "Your session has ended. Sign in again." |
| FT-AUTH-103 | P0 | Sec | Use an access token after logout, after password reset, after suspension | Refused (S4-6) |
| FT-AUTH-104 | P1 | Sec | Call `/api/auth/refresh` or `/logout` from another origin, with `Origin: null`, with `Sec-Fetch-Site: cross-site` | `403` "This request must come from this site."; no cookie set |
| FT-AUTH-105 [MT-AUTH-25] | P1 | Pos | Signed out, open `/records/donation?id=<id>`, `/admin`, `/builder`, `/print/receipt/<id>` | Sent to sign-in with `next`; after sign-in returns to that page if allowed |
| FT-AUTH-106 | P0 | Sec | `next=https://evil.example`, `//evil.example`, `/\evil`, `javascript:alert(1)`, `%2F%2Fevil`, a path with a control character, a path over 2000 characters | Each falls back to `/` (S4-5) |
| FT-AUTH-107 | P1 | Pos | Role removed while signed in | Next request uses the new roles; within 5 seconds on every server |
| FT-AUTH-108 | P1 | Sec | Every `/api/` route called with no credentials | `401` or `403`, never `422` or `500` |

## 12. Shell, navigation and layout (`NAV`)

More is not a screen and not a backend concept. The server stores one ordered list of destinations. The app folds that list when it does not fit: on a phone the bar has 4 slots, and from 760 px the rail fits as many 57 px icons as the window allows under the 56 px app bar (10 px padding, 4 px gaps, icons not shrunk). The last slot becomes More only when something does not fit, and it opens those leftover links in order. When everything fits, More is absent. On a phone, Sign out stays in that overflow. Decided 2026-11-03.

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-NAV-001 [MT-NAV-01] | P0 | Pos | As ADMIN visit Home, Records, Inbox, Settings, Administration, Builder | Each opens with its heading. None of them is a More screen |
| FT-NAV-002 | P1 | UI | Phone width, with few destinations and then with more than 4 | Four slots. More is absent when they fit. When they do not, the last slot is More and opens only the links that did not fit, Sign out among them. The address does not change to a More page. Escape closes the sheet; navigating closes it |
| FT-NAV-003 | P1 | UI | Desktop, then shrink the window height until the rail overflows, then grow it again | Side rail. More appears only for the links that no longer fit, in the same order, and disappears again when they fit |
| FT-NAV-004 | P1 | UI | Tablet 760–1099 px | Side rail; tables with compact columns; Cards/Table switch shown |
| FT-NAV-005 [MT-NAV-02] | P0 | Neg | As ADMIN, FIN, DIR, and NOACCESS, look through the bar, the More sheet, Home, and Settings | People is not a destination for anyone. Administration and Builder are absent for DIR and NOACCESS, and `/admin` and `/builder` send them to `/` |
| FT-NAV-006 [MT-NAV-03] | P0 | Neg | FIN opens `/admin/settings`, `/builder/recordType/donation` | Redirected; no data shown |
| FT-NAV-007 | P1 | Neg | PEOPLE-ADMIN opens `/admin/api-keys` | Redirected to `/admin` |
| FT-NAV-008 | P1 | Pos | App bar | Product name, organisation logo and name, Inbox bell, initials ("Account and settings"); no page name in the bar |
| FT-NAV-009 | P1 | Pos | Inbox badge with 0, 3, and 120 waiting approvals | Hidden, "3", "99+". Unread notifications do not count |
| FT-NAV-010 [MT-IN-01] | P1 | Pos | Another user creates an approval for me; wait 60 s with the tab visible; then hide the tab for 2 minutes | Badge updates within about 60 s while visible; no polling while hidden; updates on navigation |
| FT-NAV-011 | P1 | Pos | Sign out from the initials | Dialog "Sign out?" "You will be signed out on this device and will need to sign in again." Cancel keeps the session; Escape and backdrop cancel; Sign out goes to `/sign-in` |
| FT-NAV-012 [MT-NAV-05] | P1 | Pos | Breadcrumb on desktop for a donation in Mark as paid | `Records › Fundraising › Donations › DON/2026-27/00040 · <name> › Mark as paid`; every item but the last is a link; last has `aria-current="page"` |
| FT-NAV-013 | P1 | UI | Same on phone | First item, "…", last item; "…" (accessible name "Show the full trail") opens a menu with the full trail |
| FT-NAV-014 | P2 | Pos | No breadcrumb on sign-in, reset password, print | None shown |
| FT-NAV-015 | P1 | Pos | Back button | Hidden on `/`, `/records`, `/inbox`; elsewhere returns to the previous in-app screen, or the nearest linked crumb when opened directly |
| FT-NAV-016 | P1 | Pos | Open `/more`, `/people`, `/admin/settings`, `/admin/theme`, `/admin/layout`, `/builder/roles`, `/builder/roles/finance`, `/records/donation/new`, `/records/donation/<id>`, `/nope` | `/more` is not a screen and does not load a More resource; it goes to `/`. `/people` is not a route and goes to `/`. Then `/admin/organisation/identity`, `/builder/theme`, `/builder/layout`, `/admin/roles`, `/admin/roles/finance?tab=permissions`, `?create=new`, `?id=<id>`, `/` |
| FT-NAV-017 | P2 | Pos | Browser tab titles | "<screen or organisation name> \| OneNGO" |
| FT-NAV-018 | P1 | Pos | Builder → Layout publishes a new order and icons | One order is stored. Bar and rail follow it for every member on next load. Home stays. The saved layout has no More group |
| FT-NAV-019 | P0 | API | Read the published layout. Publish a page. Send a layout whose body contains a `more` list, and a page with `placement` `more` | The layout is one list of destinations. A page is Home or one destination in that list. A More group and `placement: "more"` are refused. There is no More route or More payload on the API |

## 13. Home, pages, widgets and pins (`HOME`)

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-HOME-001 [MT-NAV-06] | P0 | Pos | NOACCESS opens Home | "You do not have access to any records yet. Ask an administrator to give you a role." |
| FT-HOME-002 | P1 | Pos | FIN opens Home with no published home page | "Welcome, {name}" and record groups only |
| FT-HOME-003 | P1 | Pos | Publish a home page with stat, chart, list, links, groups widgets | Each renders; phone one column, wider two columns; groups widget full width |
| FT-HOME-004 | P1 | Pos | Stat "See all" and list rows | Open the list with the widget's filter; a row opens the record (`?id=`) |
| FT-HOME-005 | P1 | Bnd | List widget limit 1, 5, 20, 21 (Builder) | 21 refused at publish; default 5 |
| FT-HOME-006 | P1 | Neg | Widget summing a sensitive field; chart grouped by a text field | Refused at publish |
| FT-HOME-007 | P0 | Sec | VIEW sees a total widget over a type where some records are restricted | Figures include only what VIEW may see ("figures you are allowed to see") |
| FT-HOME-008 | P1 | Pos | A widget fails to load (stop the API for that call) | "This could not be loaded." with Retry; other widgets unaffected |
| FT-HOME-009 | P2 | Pos | Empty widget | "Nothing to show yet." |
| FT-HOME-010 | P1 | Pos | Page in More (`/pages/<key>`) with an audience role; open as a member outside the audience | "You do not have access to this page." |
| FT-HOME-011 | P1 | Pos | Widget or link with a `permission` the viewer lacks | Hidden |
| FT-HOME-012 | P2 | Sec | Link widget to an external address | Only in-app links are shown |
| FT-HOME-013 [MT-NAV-07] | P1 | Pos | Pin a list to my Home; rename; move up and down; unpin | Message `Pinned to your Home as "{label}".`; tagged "Your pin" and first; 3 rows; changes only for this person |
| FT-HOME-014 | P2 | Bnd | Rename pin to 80 characters, 81, empty | 80 saved; 81 blocked by field; empty: record what happens (no client check, documented) |
| FT-HOME-015 [MT-NAV-08] | P1 | Pos | Pin to everyone's Home | "Added to the Home page draft. Publish it in the Builder to show it to everyone." Others see it only after publish and only if allowed |
| FT-HOME-016 | P2 | Neg | Pin to everyone's Home as a person without publish permission | Option absent |
| FT-HOME-017 | P1 | Pos | Charts | Bar and line; a hidden data table exists for screen readers |
| FT-HOME-018 | P2 | Pos | Page heading "Updated HH:MM · figures you are allowed to see"; aggregate cache 5 minutes | Change data; a widget may lag up to 5 minutes; record observed delay |

## 14. Records (`REC`)

Run against Donations and against at least one organisation-built record type that has every field type (build it in section 20). Mark a case Not run when the published type lacks the feature, and put the type name in the notes.

### 14.1 Record groups and the Records screen

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-REC-001 [MT-REC-01] | P0 | Pos | Open Records as FIN | Fundraising holds Donors then Donations; types in no group sit under Other; one column on every width |
| FT-REC-002 | P1 | Pos | Collapse a group, reload, sign in on another browser | Collapsed state remembered on this device |
| FT-REC-003 [MT-REC-02] | P1 | Bnd | 8 readable types, then 9 | Search box appears only with more than 8; "No record types match." when empty |
| FT-REC-004 | P0 | Sec | VIEW without read on a type | The type is absent; a group left empty is hidden; opening `/records/<type>` says "This record type does not exist or you cannot see it." |
| FT-REC-005 | P2 | Pos | No record counts on Home or Records | None shown (signed-off decision) |

### 14.2 Record list

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-REC-010 | P1 | Pos | Donations list, chips Mine, Outstanding (default), Closed | Each chip filters correctly; Outstanding = Raised; Closed = Paid or Cancelled; changing chip goes back to page 1 |
| FT-REC-011 [MT-REC-03] | P1 | Pos | Search "Ravi"; check timing | Request fires about 300 ms after typing stops, not per key; placeholder "Search donations…" |
| FT-REC-012 | P1 | Pos | Sort by amount three times; then use the table header | ▲ ascending, ▼ descending, cleared; header and Sort menu stay in step; `sort=amount` / `sort=-amount` in the address |
| FT-REC-013 | P1 | Pos | Filters: method multi-select, paid-on range, amount range; Apply; remove one pill; Reset | Filter count badge; pills "Remove filter: …"; removing one keeps the others; Reset clears all |
| FT-REC-014 | P1 | Neg | Amount from 500 to 100; date From after To | Record behaviour: no results or a message. No error page |
| FT-REC-015 | P0 | Sec | Filter or sort by a sensitive field (PAN) through the address or API | Refused: "'PAN' cannot be filtered: you cannot see it." / sensitive fields never filter |
| FT-REC-016 [MT-REC-05] | P1 | UI | Cards/Table switch on desktop; reload; shrink to phone | Choice kept (device storage); phone always cards; table shows all columns from 1100 px, compact columns on tablet (max 6) |
| FT-REC-017 | P1 | Pos | Scroll to end of 12-per-page donations | "Loading more…", then "End of list"; the "Load more" button appears on keyboard focus and is always visible with reduced motion |
| FT-REC-018 | P1 | Bnd | Address `show=13`, `show=500`, `show=600` | Rounded to whole pages; capped at 500 |
| FT-REC-019 | P1 | Pos | Copy the full list address with chip, q, filters, sort, show, view, and open in a new tab | Same screen reproduced; breadcrumb identical |
| FT-REC-020 | P2 | Neg | Address with unknown chip, bad sort field, garbage filter values | Bad values dropped silently; list loads |
| FT-REC-021 | P1 | Pos | History: change chip (replaces entry), open a record (adds entry), Back | Back closes the record, not the chip change |
| FT-REC-022 | P1 | Pos | List load fails (offline) | "We could not load the records. Check your connection and try again." with Retry |
| FT-REC-023 | P2 | Pos | Empty view | "Nothing matches this view." with Clear filters |
| FT-REC-024 | P1 | Pos | Last opened record | Highlighted on return |
| FT-REC-025 | P1 | Pos | Row ⋮ menu | Edit, then the steps allowed from the record's state, then actions |
| FT-REC-026 | P1 | Pos | Create button | "New donation" in the title row on wide screens; floating button on phones; shown only when the chip allows create and the person has create permission |
| FT-REC-027 | P2 | Pos | Notices | Normal notices close after 4 s, errors after 8 s |
| FT-REC-028 | P1 | API | `POST /api/records/donation/query` with conditions, search, sort, sums, paging; `POST /aggregate` with count and sum | Same rows as the screen; sums exclude records the caller cannot see |
| FT-REC-029 | P2 | Pos | Location "within X km" filter on a type with a location field: 0 km, 1000 km, 1001 km | 0 and 1001 refused; 1000 accepted |

### 14.3 Record panel: view, create, edit

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-REC-040 | P1 | UI | Open a record on phone and desktop | Bottom sheet on phone (up to 92% height); centred sheet up to 720 px on desktop (880/1080 for 2/3-column forms); focus trapped; page behind inert; Escape and backdrop close; Back closes |
| FT-REC-041 | P1 | Pos | Detail sections | Field sections (hidden `visibleWhen` fields left out), receipts, related records (latest 10, count, total) |
| FT-REC-042 [MT-REC-06] | P0 | Neg | Create with required fields empty | "{field} is required." under each; nothing saved |
| FT-REC-043 | P0 | Pos | Create with valid data | "The record has been created."; number assigned; new record at top of the list; panel shows the record |
| FT-REC-044 | P1 | Pos | Two-step create stepper (Donor, then Details) | "Step 1 of 2"; Cancel on step 1, Back on step 2; Next validates only the current step; `createStep` in the address; reload keeps the step |
| FT-REC-045 | P1 | Pos | Create with a preset in the address (`?create=new&donor=<id>`) | Donor preselected and copied fields filled |
| FT-REC-046 [MT-REC-07] | P1 | Pos | Edit, change, Save changes; Edit again, Cancel edit | "Your changes have been saved."; cancel leaves the saved state |
| FT-REC-047 | P0 | Con | Two users open Edit on the same record; A saves; B saves | B gets "This record was changed by someone else. Reload it and try again." (409); A's change kept |
| FT-REC-048 | P1 | API | `PATCH` without `expectedVersion` | `400 bad_request` |
| FT-REC-049 | P1 | API | Create with `Idempotency-Key` twice with the same body; then same key, different body | First: one record, the replay returns the same response with `idempotent-replayed: true`. Second: record behaviour (refused or new); file if a second record is silently created with the same key |
| FT-REC-050 | P1 | Neg | API body with an unknown field | "“x” is not a field of this record." |
| FT-REC-051 | P1 | Neg | Set a calculated field (`netAmount`) or rollup field (`totalGiven`) by API | "is calculated and cannot be set" / "is kept up to date automatically and cannot be set" |
| FT-REC-052 | P1 | Pos | Clear an optional text field and save | Field removed; text trimmed |
| FT-REC-053 | P1 | Neg | Edit a record in a final state (Paid donation, field without `editableWhen`) | "Records that are Paid cannot be edited." where the state is locked/final |
| FT-REC-054 | P1 | Pos | Offline during edit | Save and Create disabled; offline banner shown |
| FT-REC-055 | P2 | Pos | Field placeholders | Grey example text (for example `ABCDE1234F`), not stored |
| FT-REC-056 | P1 | Pos | Deep link `/records/donation?id=<id>` as reader, as non-reader, as another organisation's member | Reader lands on the record; others get not found / no access, never the data |

### 14.4 Field types and field options

| ID | Pri | Type | Field | Steps and values | Expected |
| --- | --- | --- | --- | --- | --- |
| FT-REC-070 | P1 | Bnd | text | 500 and 501 characters (default max); a per-field `maxLength` | Over-limit refused |
| FT-REC-071 | P1 | Bnd | longText | 20,000 and 20,001 | 20,001 refused |
| FT-REC-072 | P1 | Bnd | number / money | `min`/`max` at the limit and one past; money `10.555` | Out-of-range refused; money "must be an amount with at most two decimal places" |
| FT-REC-073 | P1 | Neg | email | `name@`, `a b@c.d`, 255 characters, `Name@Example.org` | Invalid refused: "Enter a valid email address, like name@example.org." |
| FT-REC-074 | P1 | Bnd | phone | `12345`, `123456`, `+91 98765 43210`, 21 characters, `98765-ABC` | 5, 21, letters refused: "Enter a valid phone number, like +91 98765 43210." |
| FT-REC-075 | P1 | Neg | date | `31/02/2027`, `2027-13-01` | "Enter a valid date, like 2026-04-01." |
| FT-REC-076 | P1 | Neg | choice | Value not in the list (API) | Refused |
| FT-REC-077 | P1 | Neg | multiChoice | Same value twice (API) | "…lists the same choice more than once." |
| FT-REC-078 | P1 | Pos | boolean | Toggle and save | Stored |
| FT-REC-079 | P1 | Pos | reference + record picker | Type 2 letters | Search after about 250 ms; up to 8 matches with a second line; `New donor "<text>"` creates and selects; ✕ "Clear {field}" clears |
| FT-REC-080 | P0 | Sec | reference | Person without read on the referenced type | Picker locked; API: "cannot be chosen: you cannot see these records" |
| FT-REC-081 | P1 | Neg | reference | UUID of a deleted, other-type, or other-organisation record | "was not found" |
| FT-REC-082 | P1 | Pos | person | Pick an active member; try a suspended member and an invited member by API | Active saved, shown by name; suspended "is not an active member of the organisation"; record what happens with invited (open question) |
| FT-REC-083 | P1 | Pos | person | Filter "Assigned to me" | Only records where the field is me |
| FT-REC-084 | P1 | Pos | file | Drag, Choose files, Take photo (phone); PDF, PNG, DOCX, XLSX | Each attaches with its own progress bar and Cancel; images and PDF preview inline |
| FT-REC-085 | P1 | Neg | file | SVG; `.exe` renamed to `.pdf`; a type outside `accept` | "This file type is not supported. Use {kinds}." Content sniffing catches the renamed file |
| FT-REC-086 | P1 | Bnd | file | 25 MB and 25 MB + 1 byte; field `maxSizeMb` 2 with 2 MB + 1 byte | "This file is too large. The limit is {size}." |
| FT-REC-087 | P1 | Bnd | file (multiple) | 20 files, 21 files | 21: "Add at most 20 items…" |
| FT-REC-088 | P1 | Neg | file | Save while an upload is still running | "Please wait for the upload to finish." |
| FT-REC-089 | P0 | Sec | file | Attach another user's unlinked upload id by API; attach a file already linked to another record; same file in two fields | "refers to a file that was not found" / "…attached elsewhere" / "…already in another field" |
| FT-REC-090 | P1 | Sec | file | Open `/api/files/<id>` without read on its record; from another organisation | 404 |
| FT-REC-091 | P2 | Pos | file | Upload and never save; check after 24 hours | Unlinked upload removed |
| FT-REC-092 | P1 | Neg | file | Upload as `multipart/form-data` (API) | `422 validation_failed` (raw body only) |
| FT-REC-093 | P1 | Neg | file | Organisation quota full | "The organisation's file storage is full…" |
| FT-REC-094 | P2 | Pos | location | Use my location; Type coordinates; Open in maps | Stored and shown; maps opens OpenStreetMap in a new tab |
| FT-REC-095 | P2 | Bnd | location | lat 90 / 90.1; lng -180 / -180.1; 7 decimals; only latitude | Out of range "{field}: −90 to 90."; 7 decimals refused; one value: "{field} is required." |
| FT-REC-096 | P2 | Neg | location | Block location permission; low accuracy over 100 m | "Location blocked…"; "Low accuracy (...): try outdoors or type coordinates." |
| FT-REC-097 | P2 | Pos | signature | Sign, optional signer name, save, reopen | "Signed by {name} on {when}"; server sets signedAt; only Clear offered afterwards |
| FT-REC-098 | P2 | Neg | signature | Change an existing signature by API; upload a 201 KB or a JPEG signature | "is already signed; it can only be cleared"; "must be a signature image of at most 200 kB" |
| FT-REC-099 [MT-REC-13] | P2 | Pos | richText | Bold, italic, underline, lists, heading, quote, web link, email link | Stored and shown |
| FT-REC-100 | P0 | Sec | richText | Paste `<script>`, `<img onerror>`, `javascript:` link, `style` | Unsafe parts removed; "Only web and email links."; nothing executes when reopened or exported |
| FT-REC-101 | P2 | Bnd | richText | 50,000 and 50,001 characters | "Keep this to {max} characters or fewer." |
| FT-REC-102 | P1 | Pos | copyFrom | Choose a donor on a donation | Name, email, phone, PAN copied and locked; change the donor's email later: existing donation keeps the old copy; choose another donor: values copied again |
| FT-REC-103 | P1 | Pos | copyFrom | Clear the donor | Copied fields become editable |
| FT-REC-104 | P1 | Pos | calculated | Donation amount 1000 fee 10 | Net 990; not editable |
| FT-REC-105 | P1 | Pos | rollup | Paid donations 1000 and 500, one raised 200, one cancelled 300 | Donor total given 1500, count 2; move a paid donation to another donor: both donors recalculated |
| FT-REC-106 | P0 | Pos | unique | Second donor with PAN `ABCDE1234F`; differing only in case where allowed; blank PAN twice | "Another donor already has this PAN." Blanks may repeat |
| FT-REC-107 | P1 | Pos | unique | An old record that already breaks a newly added unique rule is edited on another field | Saves (only changed values are checked) |
| FT-REC-108 | P1 | Neg | pattern | Value not matching; type without `patternMessage` | Field message, or "is not in the expected format" |
| FT-REC-109 | P0 | Sec | sensitive | VIEW opens a donor with PAN | `***` with no partial characters; export and notifications masked too |
| FT-REC-110 | P0 | Sec | sensitive | Send back `***` in an update | Ignored; stored value unchanged |
| FT-REC-111 | P1 | Sec | readPermission | Field with "Who can see" a permission VIEW lacks | Masked `***`; cannot filter, sort, or sum by it (403 naming it) |
| FT-REC-112 | P1 | Sec | editPermission | Field with "Who can change" a permission FIN lacks | Read-only on screen; API: "you may not change 'Label'" (422) in create, update, import, bulk |
| FT-REC-113 | P1 | Pos | visibleWhen | Condition false | Field hidden; submitted value ignored; stored value kept; required not enforced while hidden |
| FT-REC-114 | P1 | Pos | editableWhen | Condition false | Read-only; changing it by API: "cannot be changed now" |
| FT-REC-115 | P2 | Pos | numbering | Donor `DNR/00001`…; donation `DON/2026-27/00001` | Formats correct; donor never resets; donation resets per financial year |

### 14.5 Sharing and restricted visibility

Needs a record type with visibility "only their own and shared" (build in section 20; Donations is not restricted).

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-REC-130 | P0 | Sec | User X creates a record; user Y with read (no `read:all`) lists the type | Y does not see it; opening by id gives not found |
| FT-REC-131 [MT-REC-19] | P0 | Pos | X shares with Y "Can view", then with a role "Can edit", no end date | "Shared with {name} ({line})."; Y can open but not save; role members can save |
| FT-REC-132 | P1 | Pos | "Shared with me" chip | Appears automatically and lists shared records |
| FT-REC-133 [MT-REC-20] | P1 | Bnd | Ends on today; yesterday | Today accepted, ends at end of day (UTC); yesterday "Choose today or a later day." |
| FT-REC-134 [MT-REC-21] | P1 | Pos | Remove a share with ✕ | Ends immediately; "Stopped sharing with {name}." No confirmation (documented gap) |
| FT-REC-135 | P1 | Pos | Share again with the same person at a different level | The share updates; no duplicate row |
| FT-REC-136 | P1 | Neg | Y (edit share, not creator, no `share` permission) tries to share | "Only its creator or people allowed to share can share this record." |
| FT-REC-137 | P1 | Neg | Share a record of a non-restricted type (API) | "…records are visible to everyone who may see them, so they are not shared." |
| FT-REC-138 | P1 | Neg | Share with a suspended member, an unknown role | Refused |
| FT-REC-139 | P1 | Pos | Candidate search | At most 8 people or roles; 250 ms debounce |
| FT-REC-140 | P1 | Pos | Approver of a restricted record without a share | Can read it while deciding |
| FT-REC-141 | P1 | Pos | Audit log | `record.shared` and `record.unshared` entries |

### 14.6 Record actions

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-REC-150 | P1 | Pos | Action with a form, confirmation text, and steps | Form, then confirmation with Back/Cancel, then "Submitting…"; result message |
| FT-REC-151 | P1 | Neg | Action not allowed in the current state; without its permission | Absent from panel and row menu; API refused |
| FT-REC-152 | P1 | Pos | Action that opens the print view or an external address (UPI) | Opens correctly |
| FT-REC-153 | P1 | Bnd | Builder: action label 60 and 61; 10 and 11 form fields; 10 and 11 steps | Over-limit refused at publish |

### 14.7 Import

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-REC-170 [MT-REC-22] | P1 | Pos | Import → download sample → 2 valid rows → match all → create → automations off → start | 5 steps, each in the address; sample matches the list's columns; preview "will create 2"; both rows created |
| FT-REC-171 | P1 | Neg | Upload a `.txt`, an empty file, a header-only file | "Choose a CSV file (.csv)."; "no header row" / "no rows" |
| FT-REC-172 [MT-REC-24] | P1 | Bnd | 10 MB and 10 MB + 1 byte; 20,000 and 20,001 rows | "The file is larger than 10 MB."; "The file has 20001 rows; at most 20000 can be imported at once." |
| FT-REC-173 | P1 | Neg | Map no columns | "Match at least one column to a field." |
| FT-REC-174 | P1 | Neg | Map two columns to one field | "More than one column fills…" |
| FT-REC-175 | P1 | Neg | Map to a file, signature, calculated, or rollup field | Not offered / refused |
| FT-REC-176 [MT-REC-23] | P1 | Pos | Update by a unique field (PAN): one matching row changed, one new | 1 updated, 1 created |
| FT-REC-177 | P1 | Neg | Update by a non-unique field | "Records can be updated only by a unique field." |
| FT-REC-178 | P1 | Pos | One bad row, one good | Check counts 1 problem as "Row n · message"; bad row skipped; good row created |
| FT-REC-179 | P2 | Bnd | 250 bad rows | First 200 listed: "The first 200 problems are listed." |
| FT-REC-180 | P1 | Pos | Values `1,00,000.50`, `₹ 500`, `Rs 20`, `INR 5`, `31/03/2027`, `yes`, `N`, `1` | Parsed correctly |
| FT-REC-181 [MT-REC-25] | P1 | Pos | Run once with automations on, once off | Thank-you or other automations only for the "on" run |
| FT-REC-182 | P1 | Neg | Quiet import without `import:quiet` | Switch absent / refused |
| FT-REC-183 [MT-REC-26] | P1 | Pos | Cancel mid-run; download failed rows; fix and re-import | "Stopping the import…"; stops before the end; failed-rows CSV re-imports cleanly |
| FT-REC-184 | P1 | Neg | Run the same import twice (API) | `409` "This import has already started." |
| FT-REC-185 | P1 | Con | Start an import while a bulk job runs in the same organisation | Only one import or bulk job at a time; second waits or is refused, record which |
| FT-REC-186 | P0 | Pos | Import rows that break unique, pattern, required, editPermission | Each refused per row with the same checks as the screen |
| FT-REC-187 | P1 | Pos | Close the panel during import | Work continues; a notification opens the result |

### 14.8 Export

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-REC-200 [MT-REC-27] | P1 | Pos | Export a short filtered list | "Exported N records — {file}"; columns and rows match the view |
| FT-REC-201 | P1 | Pos | Export more than 50,000 rows | "The export runs in the background; a notification will bring the file." "Export ready" notification |
| FT-REC-202 | P0 | Sec | VIEW exports donors | PAN masked; only readable records |
| FT-REC-203 | P0 | Sec | Data starting with `=`, `+`, `-`, `@` | Escaped in the CSV; opening in a spreadsheet runs no formula |
| FT-REC-204 | P1 | Neg | Export without export permission; `export.csv?q=` with invalid base64 | Absent / refused; `422 validation_failed` |
| FT-REC-205 | P2 | Pos | Hindi text and ₹ in export | UTF-8 opens correctly in a spreadsheet |

### 14.9 Bulk operations and jobs

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-REC-220 | P1 | UI | Select by checkbox (table), long-press 500 ms or ⋮ → Select (cards) | Bulk bar "{count} selected"; ✕ clears |
| FT-REC-221 | P1 | Bnd | "Select all that match" with 5,000 and 5,001 matches | 5,001: "You can select up to 5000 records at a time."; API: "…a bulk operation handles at most 5,000…" |
| FT-REC-222 [MT-REC-28] | P0 | Pos | Edit fields on 10 records | Only filled fields change; each record through normal checks; results done / waiting for approval / failed; unselected untouched |
| FT-REC-223 | P1 | Neg | Edit fields with nothing filled | "Fill in at least one field to continue." |
| FT-REC-224 | P1 | Bnd | 50 records, then 51 | 50 run inline; 51 becomes a job (`202 {jobId,total}`) with progress every 1.5 s, "about N minutes left", Stop |
| FT-REC-225 | P1 | Pos | Bulk step (Cancel) on a mix of Raised and Paid | Raised cancelled; Paid reported failed |
| FT-REC-226 | P1 | Pos | Bulk action Send reminder | One delivery per eligible record |
| FT-REC-227 [MT-REC-29] | P1 | Pos | Bulk share; Stop before the end | "It stopped before the end."; some done, rest untouched |
| FT-REC-228 | P1 | Pos | Bulk export of selected rows | CSV with only selected rows |
| FT-REC-229 | P1 | Sec | A bulk edit that includes a record the person cannot change | That record failed; others done |
| FT-REC-230 | P1 | Neg | Bulk with both `ids` and `query`, with neither (API) | `400` |
| FT-REC-231 | P1 | Neg | Bulk share with a past end date | Refused |
| FT-REC-232 | P1 | Sec | Creator is suspended or loses bulk permission mid-job; API key revoked mid-job | Job fails (S4-12) |
| FT-REC-233 [MT-JOB-01] | P1 | Pos | Administration → Jobs as another administrator | Everyone's jobs listed with Waiting, Running, Done, Failed, Cancelled |
| FT-REC-234 [MT-JOB-02] | P1 | Pos | Open a failed job; Download failed rows; Cancel a running job | Failed items listed ("No failed items." when none); CSV downloads; cancel stops it |
| FT-REC-235 | P1 | Neg | Non-creator without `admin:jobs` opens or cancels someone's job by API | Refused |

## 15. Workflows, approvals and Inbox (`WF`)

### 15.1 Workflow steps

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-WF-001 [MT-REC-14] | P0 | Pos | Run a step from the panel and from the row menu | Only the step's fields (judged against the target state); "{step} completed successfully."; status badge updates |
| FT-WF-002 | P1 | Neg | Step not available from the current state (API) | "'Label' is not available from the current status." |
| FT-WF-003 | P1 | Neg | Unknown step key (API) | "Unknown step 'x'." |
| FT-WF-004 | P1 | Neg | Step without its permission | Absent; API forbidden |
| FT-WF-005 | P1 | Neg | Step with a guard that fails | `guardMessage`, or "'Label' is not allowed for this record." |
| FT-WF-006 | P1 | Neg | Required step field empty | "is required for this step" |
| FT-WF-007 | P0 | Con | Run a step with a stale `expectedVersion` | 409 conflict |
| FT-WF-008 | P1 | Pos | Record type with two primary workflows chosen by `appliesWhen` | The first matching workflow (by key) applies at create; none matches → "None of the workflows applies to this record…" |
| FT-WF-009 | P1 | Pos | Parallel workflow with `startsWhen` | Starts when true; panel shows each workflow's state and groups steps by workflow |
| FT-WF-010 | P1 | Neg | Step on a type with no workflow | "This record type has no workflow." |

### 15.2 Approvals

Build a step that needs 2 approvals from role Approver (Builder, section 20).

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-WF-020 | P0 | Pos | Requester runs the step | `"{step}" has been sent for approval.`; panel shows "Waiting for approval to "{step}" — requested by {by}, 0 of 2 approvals."; step buttons disabled |
| FT-WF-021 [MT-REC-15] | P0 | Neg | Requester approves own request | "You cannot approve your own request." |
| FT-WF-022 | P0 | Pos | Approver 1 approves | "Your approval was recorded."; 1 of 2 |
| FT-WF-023 | P0 | Neg | Approver 1 approves again | "You have already decided this request." |
| FT-WF-024 [MT-IN-02] | P0 | Pos | Approver 2 approves | "Approved and applied."; step applied; request leaves the list |
| FT-WF-025 | P0 | Neg | Non-approver tries to decide (API) | "You are not an approver for this step." |
| FT-WF-026 [MT-IN-03] | P1 | Pos | Reject with a reason; reject another without | One reject ends the request; "Rejected."; reason stored (cut at 1,000 characters) |
| FT-WF-027 [MT-REC-16] | P0 | Con | Someone edits the record while the request is open; approver decides | Request stale: "The record changed after the request was made. Ask the requester to submit it again." |
| FT-WF-028 [MT-IN-04] | P1 | Con | Two approvers open the list; one decides; the other decides from the stale list | "This request has changed since you opened it. Refresh and try again." |
| FT-WF-029 | P1 | Neg | Run a second approval step while one is pending | "This record already has a step waiting for approval." |
| FT-WF-030 | P1 | Pos | Requester withdraws; another person tries to withdraw | Withdrawn; "Only the requester can withdraw this request." |
| FT-WF-031 | P1 | Pos | Approval with `when` false | Step applies without approval |
| FT-WF-032 | P1 | Neg | Decide an already decided request (API) | "This request has already been decided." |
| FT-WF-033 | P1 | Pos | Guard fails at final approval | Request stale with that message |
| FT-WF-034 | P1 | Bnd | Builder: approval count 0, 1, 5, 6 | 0 and 6 refused |
| FT-WF-035 | P1 | Pos | Bulk step on records needing approval | Each reported "waiting for approval" |

### 15.3 Inbox

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-WF-050 | P1 | Pos | Open `/inbox` with and without waiting approvals | Opens on Approvals if anything waits, else Notifications; chips show counts |
| FT-WF-051 | P1 | Pos | Approvals list columns | Record (number and title), type, step, from → to, requested by, waiting since, given/needed, Approve, Reject; cards on phone, table from 760 px |
| FT-WF-052 | P1 | Pos | Search (300 ms), sort by waiting/record/type/step/requested by, filters type/step/requested by | Default longest waiting first; pills; all in the address |
| FT-WF-053 | P1 | Pos | Open a row | Record panel with the request at the top |
| FT-WF-054 | P1 | Pos | Reject sheet | Titled `Reject "{step}"`, optional reason; no browser prompt |
| FT-WF-055 | P2 | Pos | Empty | "Nothing is waiting for you." |
| FT-WF-056 [MT-IN-05] | P1 | Pos | Notifications: open one; Mark all read | Opening marks it read and goes to its target; read ones dimmed; Mark all disabled when nothing is unread |
| FT-WF-057 | P1 | Pos | More than 20 notifications | 20 per page, Load more |
| FT-WF-058 [MT-IN-06] | P1 | Pos | Notifications for import, export, bulk results | Each opens its result |
| FT-WF-059 | P2 | Pos | No notifications | "No notifications." |
| FT-WF-060 | P1 | Pos | Tab change | Adds a history entry; Back returns to the other tab |

## 16. Donations module (`DON`)

Preconditions: Donations enabled; financial year open; receipt series reviewed; FIN and VIEW exist; email connector or OneNGO mail available for reminder cases.

### 16.1 Donor

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-DON-001 [MT-DON-03] | P0 | Pos | FIN creates donor with name, email, phone, city, address, PAN `ABCDE1234F` | Saved as `DNR/00001` style |
| FT-DON-002 [MT-DON-04] | P0 | Neg | PAN `abcde1234f`, `ABCDE12345`, `ABCD1234F`, 11 characters | "Enter the PAN as five letters, four digits and a letter, for example ABCDE1234F." |
| FT-DON-003 | P0 | Neg | Second donor with the same PAN | "Another donor already has this PAN." |
| FT-DON-004 | P1 | Bnd | Name 200 / 201; city 100 / 101; address 1,000 / 1,001 | Over-limit refused |
| FT-DON-005 | P1 | Neg | Name empty | "Name is required." |
| FT-DON-006 | P1 | Pos | Search by name, email, phone | Found by each |
| FT-DON-007 | P1 | Pos | Donor list | 20 per page; table name, email, phone, city; city filter |
| FT-DON-008 | P1 | Pos | Donor detail | Related Donations section with total of amount; "New donation for <name>" opens create with donor chosen |
| FT-DON-009 | P0 | Pos | Totals | `totalGiven` and `donationCount` include only Paid donations |

### 16.2 Donation

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-DON-020 [MT-DON-05] | P0 | Pos | Two-step create: donor, then amount 1000, fee 10 | Copied fields locked; net 990; status Raised; number `DON/2026-27/00001` style |
| FT-DON-021 | P1 | Pos | Donation with no donor | Donor name required and typed; email/phone/PAN optional; PAN pattern still applies |
| FT-DON-022 [MT-DON-06] | P1 | Neg | Fee 1001 on 1000 | "The processing fee cannot be more than the donation." (UX-012: check it shows on the field, not only as a panel alert) |
| FT-DON-023 | P1 | Bnd | Fee equal to amount; fee 0; fee -1 | Equal and 0 accepted; -1 refused |
| FT-DON-024 [MT-DON-07] | P1 | Bnd | Amount 0, 0.99, 1, 1.005, 99,999,999.99 | 0 and 0.99 refused (minimum 1); 1.005 refused (2 decimals) |
| FT-DON-025 | P1 | Pos | Method, paid on, reference before Paid | Hidden while Raised |
| FT-DON-026 [MT-DON-08] | P0 | Pos | Mark as paid: Bank transfer, today, reference | Status Paid; "Mark as paid — receipt RCPT/2026-27/00001 issued."; method and paid-on required |
| FT-DON-027 [MT-DON-09] | P0 | Neg | Paid on tomorrow | "The payment date cannot be in the future."; stays Raised |
| FT-DON-028 | P1 | Bnd | Paid on today in the organisation's time zone near midnight UTC | Record behaviour; `today` is a UTC date in expressions. File if an Asia/Kolkata user is refused before 05:30 IST |
| FT-DON-029 [MT-DON-10] | P1 | Neg | Method UPI with empty reference | "Enter the UPI transaction reference." |
| FT-DON-030 | P1 | Bnd | Reference 100 / 101 characters | 101 refused |
| FT-DON-031 | P1 | Pos | Each method: UPI, cash, bank transfer, cheque, online gateway | All accepted; cash posts debit CASH, the rest debit BANK |
| FT-DON-032 [MT-DON-07] | P1 | Neg | Edit amount or fee after Paid | Refused (`editableWhen` raised only) |
| FT-DON-033 [MT-DON-11] | P1 | Pos | Cancel a Raised donation; then Mark as paid or Cancel it | Cancelled; no further steps offered; API refused |
| FT-DON-034 | P1 | Neg | Cancel a Paid donation | Not offered; API refused |
| FT-DON-035 [MT-DON-12] | P0 | Pos | After Paid, open Receipts | Receipt `RCPT/<fy>/<seq>` with amount = donation amount and date = paid on; audit has the money event |
| FT-DON-036 [MT-DON-13] | P0 | Pos | Mark three more paid | Receipt sequence +1 each time; no gaps, no repeats |
| FT-DON-037 | P0 | Pos | Posting | One balanced journal: debit CASH or BANK, credit DONATION_INCOME, amount = donation amount |
| FT-DON-038 | P1 | Pos | Thank-you email on Paid | Sent to donor email when mail is on; skipped with a reason otherwise |
| FT-DON-039 | P1 | Pos | Chips Mine, Outstanding, Closed; filters method, paid-on, amount | Correct sets; 12 per page |
| FT-DON-040 [MT-DON-02] | P0 | Sec | VIEW: create, edit, step, actions, print by URL and API | Read works; every change refused; actions absent |

### 16.3 Donation actions

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-DON-050 [MT-REC-18, MT-DON-14] | P1 | Pos | Send reminder on Raised with donor email (panel, row, bulk) | Confirmation "Send a payment reminder to the donor by email?"; the reminder is sent — through the organisation's email connector where it has one, otherwise through OneNGO's email service — and a delivery or notification appears |
| FT-DON-051 | P1 | Neg | Send reminder on Paid, or Raised without email | Not offered |
| FT-DON-052 | P1 | Neg | Send reminder with no organisation connector and no installation mail | Nothing sent; the notification shows skipped, "Email is not configured for this organisation." |
| FT-DON-053 | P1 | Pos | Pay now on Raised | UPI payment intent created; UPI link opens; after confirmation the donation is Paid with mapped fields |
| FT-DON-054 | P1 | Neg | Pay now twice | "This record already has a payment waiting." |
| FT-DON-055 [MT-DON-15] | P1 | Pos | Print receipt on Paid | Print view with legal name, logo, signatory |
| FT-DON-056 | P1 | Neg | Print receipt on Raised | Not offered |

## 17. Finance engines (`FIN`)

### 17.1 Financial year

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-FIN-001 | P0 | Pos | Organisation with April start, no year opened, no receipts; change start month to 1 | Saved; audited with old and new month |
| FT-FIN-002 [MT-ADM-05] | P0 | Neg | After a year is open or a receipt exists, change the month | "The financial year start month cannot change once a financial year has been opened or a receipt issued…"; Settings shows the month read-only with "Fixed: …" |
| FT-FIN-003 | P2 | Pos | Save the same month again after it is fixed | Accepted |
| FT-FIN-004 | P1 | Bnd | Month 0, 13 (API) | Refused |
| FT-FIN-005 | P0 | Bnd | Donations paid on 31 Mar 2027 and 1 Apr 2027 (April start) | Receipts `…/2026-27/…` and `…/2027-28/00001`; donation numbers follow the creation date's year |
| FT-FIN-006 | P1 | Bnd | January start: 31 Dec 2026 and 1 Jan 2027 | Labels `2026` and `2027` |
| FT-FIN-007 | P0 | Neg | Post into a year not open; into a closed year | "Financial year 2027-28 is not open." / "…is closed." |
| FT-FIN-008 | P1 | Con | Change start month and issue a receipt at the same moment | One wins; never a receipt with a changed start month afterwards |

### 17.2 Receipts

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-FIN-020 | P0 | Pos | Receipt numbering | Gap-free per series and year; `PREFIX/<fy>/00001`; `PREFIX/00001` when the series never resets |
| FT-FIN-021 | P0 | Con | Mark 20 donations paid in parallel (bulk or API) | 20 distinct consecutive numbers |
| FT-FIN-022 | P0 | Pos | Void a receipt with a reason | Number kept; "Void: {reason}" watermark; reason shown in the list |
| FT-FIN-023 | P1 | Neg | Void without reason; void twice | "A reason is required to void a receipt."; "This receipt is already void." |
| FT-FIN-024 | P0 | Pos | Replacement | Original voided; new number linked to it |
| FT-FIN-025 | P0 | Pos | Issuer snapshot | Change legal name, logo, signatory, registrations after issue; reprint the old receipt: shows the original identity |
| FT-FIN-026 | P1 | Pos | Print view | Back, Download (PDF built in the browser), Copy public link, Revoke public link, Print; buttons hidden when printed |
| FT-FIN-027 | P1 | Pos | Copy public link; open signed out | `/r/<token>` shows the receipt with Download and Print only |
| FT-FIN-028 | P0 | Sec | Revoke the link; open old address; copy a new link | Old: "This receipt link is not available."; new address differs |
| FT-FIN-029 | P1 | Sec | Random, malformed, and revoked tokens | Same answer and similar timing; 20 per minute per address limit |
| FT-FIN-030 | P1 | Neg | `/print/receipt/<id>` as VIEW without print, and for another organisation's receipt | Refused / not found |
| FT-FIN-031 | P2 | UI | Print view under 600 px | Phone layout |
| FT-FIN-032 | P1 | Neg | Receipt amount 0 (via a receipt rule) | "Receipt amount must be more than zero." |

### 17.3 Ledger, money accounts, transfers (API and scripts)

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-FIN-040 | P0 | Neg | Journal with one line; negative amount; a line with both debit and credit; debits ≠ credits by 0.01 | "A journal entry needs at least two lines."; refused; refused; "Journal entry does not balance: debits X, credits Y." |
| FT-FIN-041 | P1 | Neg | Journal to an inactive or unknown account | Refused |
| FT-FIN-042 | P1 | Pos | Reverse an entry with a reason; reverse again | Reversed; "This entry has already been reversed." |
| FT-FIN-043 | P1 | Neg | Reopen a closed period without a reason | Refused |
| FT-FIN-044 | P1 | API | Open money account: key `bank-2`, `Bank`, 42 characters; UPI `ngo@okaxis`, `ngo`, `@x` | Invalid keys and UPI ids refused |
| FT-FIN-045 | P1 | API | Transfer 0; same account both sides; inactive account; more than available (non-bank); pair not in transfer matrix | Each refused with its message ("<name> has only N available.", "Transfers from X to Y accounts are not allowed.") |
| FT-FIN-046 | P1 | API | Close an account with a balance; with zero | Refused; closed |
| FT-FIN-047 | P0 | Sec | Money endpoints without `money:*` permissions | Refused |

### 17.4 Payments, gateways, webhooks

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-FIN-060 | P1 | API | `GET` gateway summary before any save | Both Razorpay and Cashfree listed as not configured, not enabled |
| FT-FIN-061 | P1 | API | `PUT` Razorpay with key id, key secret, webhook secret | Saved and enabled; secrets never returned; audit `connector.saved` |
| FT-FIN-062 | P1 | API | `PUT` Razorpay with an empty secret; unknown property; Cashfree environment `live` | `400` with issues |
| FT-FIN-063 | P1 | API | `PUT /api/admin/payment-gateways/stripe` | 404 |
| FT-FIN-064 | P0 | Sec | Gateway PUT without `payments:configure` | 403 |
| FT-FIN-065 | P0 | Sec | Create a payment of ₹1 for a ₹1,000 donation (API) | "The payment is for 1.00 but the record's receipt would be for 1000.00." (S4-1) |
| FT-FIN-066 | P0 | Sec | Create a payment naming a provider, account, or paid step that no published action asks for | "Payments are requested through a published record action; no action asks for this one." |
| FT-FIN-067 | P1 | Sec | Create a payment with `payments:create` but without the action permission | Refused |
| FT-FIN-068 | P0 | Pos | Razorpay fixture: create order, fire `payment.captured` with a valid signature | Donation Paid; one receipt; one posting |
| FT-FIN-069 | P0 | Sec | Same webhook again | `200`; no second receipt or posting |
| FT-FIN-070 | P0 | Sec | Webhook with a forged signature; unknown organisation key | `401 {ok:false}`; nothing changes |
| FT-FIN-071 | P0 | Sec | Webhook with a different amount; with no amount | Not paid; audit `payment.amount_mismatch`; intent stays `awaiting_payment` |
| FT-FIN-072 | P1 | Pos | `payment.failed` | Intent failed; donation stays Raised |
| FT-FIN-073 | P1 | Sec | Cashfree webhook with timestamp 4 min 59 s old, then 5 min 1 s old | First accepted; second refused |
| FT-FIN-074 | P1 | Pos | Manual confirm `{paidOn, bankReference}` with `payments:confirm`; without it | 204 and Paid; refused |
| FT-FIN-075 | P1 | Neg | Confirm after the donation amount changed | Refused |
| FT-FIN-076 | P1 | Pos | Statement match with a line of the same amount and the reference in the description; a line with a different amount | First matched and Paid; second not matched |
| FT-FIN-077 | P1 | Neg | Payment through a gateway not configured | Refused |
| FT-FIN-078 | P2 | Pos | UPI link | INR; payee name at most 50 characters; reference `NGO` + 8 characters |
| FT-FIN-079 | P1 | Neg | Webhook to a suspended organisation | Not processed |

## 18. Administration (`ADM`)

### 18.1 Administration home and setup checklist

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-ADM-001 [MT-ADM-01] | P0 | Pos | ADMIN opens `/admin`; PEOPLE-ADMIN opens it | ADMIN: checklist plus Organisation, People and roles, Integrations, Activity groups. PEOPLE-ADMIN: People and Roles only, no checklist |
| FT-ADM-002 [MT-ADM-02] | P0 | Pos | New organisation, nothing confirmed | Progress bar "{done} of {total} required"; "N optional open"; "{names} is still required."; not "Setup is complete." |
| FT-ADM-003 | P1 | Pos | View checklist dialog | Items identity, registrations, financial year, receipt series, people in roles, outgoing email, payments; each links to its screen; Escape closes and returns focus |
| FT-ADM-004 [MT-ADM-03] | P0 | Pos | Fill identity; **Confirm the identity** | Identity Done |
| FT-ADM-005 | P1 | Neg | Confirm identity with legal name, address, or contact email missing | Refused; stays Still to do |
| FT-ADM-006 [MT-ADM-06] | P1 | Pos | **I have reviewed the receipt series** | Receipt series Done |
| FT-ADM-007 [MT-ADM-07] | P0 | Pos | Put a member into an operational role (Finance) | Row Done; with all required rows Done: "Setup is complete."; who completed setup is recorded |
| FT-ADM-008 | P1 | Neg | Confirm an unknown checklist step (API) | not found |
| FT-ADM-009 [MT-ADM-08] | P2 | Pos | Email and payment rows with and without connectors | Stay Optional; email row says which route mail uses |

### 18.2 People

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-ADM-020 [MT-PPL-03] | P0 | Pos | Add a person with email, name, role, invite checked | Appears as Invited; hint "The link to set a password is valid for 7 days"; one mail with one link |
| FT-ADM-021 | P1 | Neg | Add with empty email or name; no role | Field errors; UX-011: required marks and "at least one role" shown? Record |
| FT-ADM-022 | P1 | Bnd | Name 120 / 121; email 254 / 255; 50 / 51 roles (API) | Over-limit refused |
| FT-ADM-023 | P1 | Neg | Add an existing active member; an existing suspended member | 409 "already a member"; 409 with a reactivate hint |
| FT-ADM-024 | P1 | Pos | Add without invitation; later Resend invitation | Status Invited; mail sent on resend |
| FT-ADM-025 | P1 | Pos | Status chips Active, Invited, Suspended, All with counts; search, sort name/joined/status, role filter; 30 per page | Correct sets; search truncated at 200 characters |
| FT-ADM-026 [MT-PPL-06] | P0 | Pos | Change roles in the person panel ("Save roles" appears only after a change) | Next request uses new roles |
| FT-ADM-027 | P1 | Pos | Bulk add role, remove role, suspend | Each applied to selected people |
| FT-ADM-028 [MT-PPL-07] | P0 | Pos | Suspend a person signed in on two devices | Confirm "Suspend {name}?"; both devices signed out; sign-in refused; name stays on records, approvals, and the audit log; they leave the Active list in Administration → People |
| FT-ADM-029 | P1 | Neg | Suspend yourself | Refused (422) |
| FT-ADM-030 | P1 | Neg | Suspend an already suspended person; reactivate an active person (API) | 409 |
| FT-ADM-031 [MT-PPL-05] | P1 | Neg | Invite or give roles to a suspended person | Refused |
| FT-ADM-032 [MT-PPL-08] | P1 | Pos | Reactivate | Can sign in; old sessions stay ended |
| FT-ADM-033 [MT-PPL-09] | P1 | Pos | Role with two-step for a person with no authenticator | Two-step column "Required · not set" |
| FT-ADM-034 | P0 | Sec | PEOPLE-ADMIN gives themself `admin`; gives someone a role beyond their own permissions | "You cannot give the role 'X': it allows more than you may do yourself." (S4-7) |
| FT-ADM-035 | P1 | Pos | Open Administration → People, then look at the bar, More, Home, and Settings | Status, invitation, and two-step are on this Administration screen. No other screen lists people |

### 18.3 People

The people list is Administration → People (`/admin/people`). There is no `/people` route. Decided 2026-11-03; the route itself was ruled out on 2026-11-04.

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-ADM-040 [MT-PPL-01, MT-PPL-02] | P0 | Pos | As ADMIN, open the bar, the More sheet, Home, and Settings, then open Administration → People. Repeat the look-around as FIN and as DIR. As DIR, open `/people` and `/admin/people` | The list is shown only at Administration → People: names, roles, and contact details, with status, invitation, and two-step on that same screen. It is absent from the bar, More, Home, and Settings. `/people` is not a route and goes to Home. DIR cannot open Administration, so they are not shown the list anywhere |
| FT-ADM-041 | P1 | API | `GET /api/people` as DIR; `?pick=1` | Active members only. This is the API used by person fields; it does not add a screen |
| FT-ADM-042 | P1 | Neg | `GET /api/people` without `people:read` | Refused |

### 18.4 Roles

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-ADM-050 [MT-ROL-01] | P0 | Pos | Open Finance; add an active and an invited person; remove one | Members (n) updates immediately |
| FT-ADM-051 | P1 | Neg | Add a suspended person or a non-member by API; 0 or 201 user ids | 422; 1–200 accepted |
| FT-ADM-052 | P0 | Neg | Remove the last person who can manage roles | 409 "This would leave nobody who can manage roles and access. Give someone else that permission first." |
| FT-ADM-053 [MT-ROL-02] | P1 | Pos | Permissions tab; turn one permission off and Save | "What this role allows. Saving updates it straight away." Save sends `PUT /api/admin/roles/:key` and "Role saved."; no draft and no publish; holders are affected on their next action |
| FT-ADM-054 | P1 | API | Create role key `finance-2`, `Finance`, `1abc`, 42 characters; label 81 characters; 501 permissions | Invalid key, label, and count refused |
| FT-ADM-055 | P1 | Neg | Delete a role with members; a role used by an API key | "…still has N members. Move them to another role first."; 409 |
| FT-ADM-056 | P1 | Pos | Add people to a role that requires two-step | Two-step note shown |
| FT-ADM-057 | P2 | Pos | Role list search | Filters only loaded rows (documented); record |

### 18.5 Connectors

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-ADM-060 [MT-CON-02] | P1 | Pos | New connector of each kind: SMS, WhatsApp, Webhook, HTTP send, HTTP lookup, OAuth | Kind required; saved; secrets shown only as "Set" with Replace |
| FT-ADM-061 | P1 | Neg | Enable with a required secret missing (WhatsApp `accessToken`, webhook `signingSecret`, OAuth `clientSecret`) | "…is needed before the connector can be enabled" |
| FT-ADM-062 | P1 | Neg | URL `http://…`, `https://10.0.0.1`, `https://localhost`, 2,001 characters | Refused (https, public addresses only unless in `CONNECTOR_ALLOWED_HOSTS`) (S4-15) |
| FT-ADM-063 | P1 | Neg | Secret name `1x`, `a-b`; secret of 4,001 characters; invalid JSON in a JSON field; non-integer in a number field | "letters, digits or _, starting with a letter"; refused; "{field} is not valid JSON."; "{field} must be a whole number." |
| FT-ADM-064 | P1 | Neg | Change the kind of a saved connector | Refused |
| FT-ADM-065 | P1 | Pos | Test a send connector to a phone/email; test a lookup | "Test accepted (answer N)." / "Test failed: …"; test delivery listed |
| FT-ADM-066 | P1 | Neg | Test a disabled connector | Refused |
| FT-ADM-067 | P1 | Pos | OAuth: Connect before save; Connect after save; deny at provider; connect state older than 10 minutes | "Save the connector, then connect it."; connected; denied message; state refused |
| FT-ADM-068 [MT-CON-03] | P1 | Pos | Delivery log chips; Retry now on a failed delivery; Retry on a sent one; on a test delivery | Retried; "This delivery was already sent."; test cannot be re-sent |
| FT-ADM-069 | P1 | Sec | Re-open a saved connector; read the API response | Secrets never returned |
| FT-ADM-070 | P2 | UI | New connector panel in the address | UX-008: currently not in the address; record |

### 18.6 API keys and the public API

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-ADM-080 [MT-KEY-01] | P0 | Pos | New key `ledger-reader` acting as Viewer | Secret shown once: "Copy this secret now. It is shown only once."; Copy → "Copied."; after "I have copied it" or reload the secret is gone |
| FT-ADM-081 | P0 | Pos | Call `POST /api/records/donor/query` with `Authorization: ApiKey <id>.<secret>` | Viewer data only, PAN masked; audit actor `api:ledger-reader`; last use updated |
| FT-ADM-082 | P0 | Sec | Revoke ("Revoke {name}? …This cannot be undone."), call again | Refused |
| FT-ADM-083 | P1 | Neg | Duplicate active name; invalid role; name 101 characters | 409; 422; refused |
| FT-ADM-084 | P0 | Sec | Create a key bound to a role with more permissions than the creator | Refused (S4-7) |
| FT-ADM-085 [MT-KEY-02] | P1 | Bnd | API requests per minute 2; send 3 in one minute | Third `429`; next minute succeeds; default 120 per key |
| FT-ADM-086 | P1 | Sec | Key secret in the query string | Not accepted; only the header |
| FT-ADM-087 | P1 | Pos | API documentation link (`/api/openapi.json`) | Generated from this organisation's published types |
| FT-ADM-088 | P1 | Sec | Key of org A against org B's data | Refused / not found |
| FT-ADM-089 | P1 | API | JSON body over 1 MiB; invalid JSON; wrong types (string for `expectedVersion`) | `400 bad_request` |
| FT-ADM-090 | P1 | API | Error envelope | `{code, message, issues?}`; every response has `x-request-id`; `Cache-Control: no-store` |

### 18.7 Audit log

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-ADM-100 [MT-AUD-01] | P0 | Pos | After a role change, setting save, paid donation, share, file upload, connector save, key creation | Each event with who, area, when; newest first; no undo |
| FT-ADM-101 | P1 | Pos | Filter by person (including API keys), area, record type, date | Correct subset; 50 per page, max 200 |
| FT-ADM-102 | P2 | UI | Readability | UX-013: raw keys and UUIDs shown; record |
| FT-ADM-103 | P1 | Neg | Audit without `admin:audit` | Absent / refused |

### 18.8 Organisation identity, profile, registrations, settings

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-ADM-110 [MT-SET-01] | P1 | Pos | Identity screen | Code and sign-in link shown, not editable; live app-bar preview |
| FT-ADM-111 | P1 | Bnd | Display name and legal name empty, 200, 201 (screen); 120/121 for display name by API | Required; over-limit refused. Note the screen says 200 for display name while the API caps at 120: record |
| FT-ADM-112 [MT-SET-03] | P1 | Pos | Logo PNG, JPEG, WebP ≤ 1 MB | Shown in app bar, sign-in page, new receipts; "Remove logo" |
| FT-ADM-113 | P1 | Neg | Logo GIF, SVG, 1 MB + 1 byte | "The logo must be a PNG, JPEG or WebP image." / "...at most 1 MB." Checked before send and on server |
| FT-ADM-114 | P1 | Sec | Request another organisation's logo | not found |
| FT-ADM-115 | P2 | Pos | Replace logo; receipts issued with the old logo; after 24 h cleanup | Old logo kept for those receipts; unreferenced old logo removed |
| FT-ADM-116 | P1 | Bnd | Signatory name and designation 120 / 121; signature PNG 200 KB / 201 KB, JPEG | Over-limit and JPEG refused; "Remove signatory" |
| FT-ADM-117 [MT-SET-02] | P1 | Neg | Profile: website `riverbank.example`, `http://…`, `https://…`; country `India`; phone 5 characters; time zone `IST` | `https://` accepted; record `http://` (conflict: doc allows, guide says https); others refused |
| FT-ADM-118 [MT-ADM-04] | P1 | Pos | Registrations: add `80g`; duplicate `80G` with different case number; expiry before issue; type `80 G`; number 81; authority 201; notes 501 | Duplicates (case-insensitive) refused; "The expiry date cannot be before the issue date."; invalid type and over-limits refused; Remove needs "Confirm remove" |
| FT-ADM-119 | P1 | Sec | Same registration number in another organisation | Allowed |
| FT-ADM-120 [MT-SET-04] | P1 | Pos | Settings: default language, storage bar "{used} of {quota} used", quota in whole GB, API requests per minute | "Settings saved."; non-integer "Enter a whole number." |
| FT-ADM-121 | P1 | Bnd | Quota 0, 10 TB, more; API cap 0, 1, max, max+1 | Out-of-range refused |
| FT-ADM-122 | P2 | Pos | Save with no changes | Nothing happens, no message (documented gap) |
| FT-ADM-123 | P1 | Neg | Any identity/profile/registrations/settings route without `admin:settings` | Refused |

### 18.9 Theme and layout

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-ADM-130 | P1 | Pos | Open Theme | Seven colours load with the published values. UX-001: currently all `#000000` with empty fields; fail until fixed |
| FT-ADM-131 | P1 | Neg | Colour `#0e7c6`, `red`; radius `8`, `100px` | "Use a colour like #0e7c66."; "Use a corner radius like 8px." |
| FT-ADM-132 | P1 | Pos | Contrast preview with five pairs | Ratio and AAA / AA / large text only / too low |
| FT-ADM-133 | P1 | Pos | Publish with a pair below AA | Dialog "Some text is hard to read": Choose another colour / Publish anyway |
| FT-ADM-134 | P1 | Pos | Publish; Reset | "Theme published…"; app and sign-in page use it; audited |
| FT-ADM-135 | P1 | Pos | Layout: reorder by drag and by keyboard; icon picker; Add a record; Remove; default list layout; Discard; Publish layout | One order, with no More column or More group. Order applied for all; screen reader announces "{item} is now {position} of {count}." (UX-007: buttons need item names) |

## 19. Settings (`SET`)

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-SET-001 [MT-ACC-01, MT-ACC-02] | P1 | Pos | Open My profile | Initials, name, roles, email, organisation; "Your name and email are changed by an administrator." UX-002: "Not found." for some users: fail if shown. Conflict on self-editable profile fields: see section 32 |
| FT-SET-002 [MT-NAV-09] | P1 | Pos | Language: each of English, हिन्दी, தமிழ், తెలుగు, বাংলা, मराठी | Applies without reload; "Selected" marker; page `lang` set; kept across sign-in; not for others |
| FT-SET-003 | P1 | Neg | Language save fails | "Could not change the language."; panel stays open with the previous language |
| FT-SET-004 [MT-ACC-04] | P1 | Pos | Two-step row | Read-only On/Off; no setup code |
| FT-SET-005 [MT-NAV-14] | P2 | Pos | Install app (Chrome, Android, iOS Safari) | Shown only with an organisation code and not installed; browser prompt, iOS "In Safari, tap Share…", or general steps; installed app opens `/o/<code>/sign-in`. Known bug: Windows Chrome letter icon |
| FT-SET-006 | P2 | Pos | Manifest | `id` `/o/<code>/`, `start_url` `/o/<code>/sign-in`, standalone, `short_name` display name ≤ 12 else code; icons 192/512/180 from logo, else heart; WebP logo falls back to heart |
| FT-SET-007 | P2 | Pos | User guide | `/guide` opens the interactive guide |
| FT-SET-008 [MT-ACC-05] | P2 | Pos | About this app | "Version {version} · {server host}" |
| FT-SET-009 | P2 | Pos | Panels in the address | `?panel=language`, `?panel=about` reopen on reload; focus to the title; Escape returns focus |

## 20. Builder (`BLD`)

Preconditions: CONFIG and ADMIN; desktop width for editing; every case on a throwaway draft unless it says publish.

### 20.1 Catalogue and editor frame

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-BLD-001 [MT-BLD-01] | P1 | UI | Open Builder on a phone | Catalogue browsable; editors read-only: "Editing works best on a tablet or computer…" |
| FT-BLD-002 | P1 | Pos | Catalogue sections Data, Process, Messages, Money, Look, Access, Advanced | Every kind listed; per kind: search above 8 items; columns Name, Kind, Key, From, State, sortable |
| FT-BLD-003 | P1 | Neg | Person with `config:read` only | Can look ("You can look at this definition…"); no New, Save, Publish |
| FT-BLD-004 | P1 | Pos | + New for each kind; record type from a starter (Beneficiary, Expense, Asset) | Key generated from the name; draft created |
| FT-BLD-005 | P1 | Pos | Edit; wait about 800 ms; blur | "Saving", then "Draft saved at…"; badges draft version, "draft on device" when offline |
| FT-BLD-006 | P1 | Pos | Check with no problems; with an error; with a warning | "No problems found."; errors listed; warnings listed (non-blocking) |
| FT-BLD-007 [MT-BLD-02] | P0 | Pos | Change a list label → Publish… → summary → Publish | Plain-language summary first; live list uses the new label |
| FT-BLD-008 | P0 | Neg | Publish with errors | "Fix these problems before publishing:" with only Back |
| FT-BLD-009 | P1 | Pos | Discard draft (browser confirm "Discard the unpublished draft?") | Draft dropped; published version unchanged |
| FT-BLD-010 | P1 | Neg | Discard when there is no draft (API) | "No draft for <kind> '<key>'." |
| FT-BLD-011 [MT-BLD-02] | P0 | Pos | History → Restore version N | "Restore version {version}? It becomes the newest published version."; live follows |
| FT-BLD-012 | P1 | Neg | Roll back to an unknown version; roll back a shipped definition | "Version N of … does not exist."; "Shipped definitions are changed through extension patches, not rollback." |
| FT-BLD-013 [MT-BLD-03] | P1 | Pos | Edit a shipped Donations definition and publish | Saved as an extension patch; badge "patched"; Changes tab compares against module |
| FT-BLD-014 | P1 | Pos | Revert to the module's version | Patch removed |
| FT-BLD-015 | P1 | Neg | Write a draft directly over a shipped key (API) | "'<key>' is a shipped <kind>. Change it with an extension patch." |
| FT-BLD-016 | P1 | Neg | Patch that changes the key; patch for a disabled module | Refused; "Enable module 'x' before changing its definitions." |
| FT-BLD-017 | P0 | Pos | Publish a changed form or workflow | Existing records unchanged (core rule) |
| FT-BLD-018 | P1 | Con | Two people edit the same definition | One draft per key; the later save replaces the draft. Record whether the first is warned |
| FT-BLD-019 | P1 | Neg | Unknown definition address | "This definition does not exist, or its only draft was discarded." |
| FT-BLD-020 | P1 | Pos | JSON tab edit then Visual tab | Both stay in step; invalid JSON blocked |
| FT-BLD-021 | P2 | Pos | Published change reaches other servers | Within about 3 s |

### 20.2 Record type editor and definition rules

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-BLD-030 | P1 | Pos | Build a test type with one field of each of the 16 field types | Publishes; usable in Records |
| FT-BLD-031 | P1 | Neg | Key `Case`, `1case`, 64 characters; field key with `-`; duplicate field | Refused; "duplicate field 'x'" |
| FT-BLD-032 | P1 | Neg | Choice with no choices; reference without type; title field missing | Refused |
| FT-BLD-033 | P1 | Neg | Unique on money, date, calculated; unique on person | Refused for money/date/calculated. Person accepted although the message says text, email, phone, number only: record (known contradiction) |
| FT-BLD-034 | P1 | Neg | Pattern `(a+)+`, with back-reference `(a)\1`, invalid regex, 201 characters; patternMessage without pattern; pattern on a number | Each refused ("repeats inside repeats are not allowed…") |
| FT-BLD-035 | P1 | Pos | Pattern that is slow on a long value | Times out after 500 ms and counts as not matching |
| FT-BLD-036 | P1 | Neg | Placeholder on boolean, file, signature, richText; `accept` on text; `maxSizeMb` 0 and 26 | Refused |
| FT-BLD-037 | P1 | Neg | Calculated with `visibleWhen`; copyFrom type mismatch ("'x' is money but this field is text"); copy from a person field | Refused |
| FT-BLD-038 | P1 | Neg | Rollup on text; rollup pointing at a type that does not reference this one | Refused |
| FT-BLD-039 | P1 | Neg | Sensitive field with a `readPermission` other than `record:<type>:sensitive` | Refused |
| FT-BLD-040 | P1 | Pos | Numbering format `INV/{fy}/{seq:4}`, reset never | Preview of next number; format errors flagged |
| FT-BLD-041 | P1 | Neg | Remove a field used by a list view or workflow | Blocked by "Used by" (browser confirm on remove) |
| FT-BLD-042 | P1 | Bnd | 25 and 26 searchable/indexed fields | Warning at the cap of 25 |
| FT-BLD-043 | P1 | Pos | Visibility "only their own and shared" | `read:all` and `share` permissions generated; "Shared with me" chip |
| FT-BLD-044 | P2 | Pos | Lookup with an http lookup connector filling fields; lookup filling money | First allowed ("Filled from the {connector} lookup."); money refused |

### 20.3 Other kinds

| ID | Pri | Type | Kind | Steps | Expected |
| --- | --- | --- | --- | --- | --- |
| FT-BLD-050 | P1 | Pos | Workflow | Diagram, states table, steps table; add a 2-approval step | Unreachable state warned; duplicate state or step key refused; step key unique across the type's workflows |
| FT-BLD-051 | P1 | Neg | Workflow | Two primaries without `appliesWhen`; `appliesWhen` on parallel | "workflow 'x' already applies to every record…"; refused |
| FT-BLD-052 | P1 | Bnd | List view | Page size 4/5/100/101; 13 columns; 7 compact columns; 9 chips; duplicate chip id; create with both fields and steps; sensitive column | Each over-limit or forbidden setting refused |
| FT-BLD-053 | P1 | Pos | List view | Live phone and desktop preview; related-records section with total and "New … for this record" | Preview matches live after publish |
| FT-BLD-054 | P1 | Bnd | Record group | Order 1000 / 1001; 30 / 31 types; a type in two groups | Lowest order wins; over-limit refused |
| FT-BLD-055 | P1 | Bnd | Page | 24 / 25 widgets; placement `home` on a non-`home` key; placement `more`; unknown audience role | Over-limit, a second Home, and `more` are refused. A page is a destination in the one navigation list |
| FT-BLD-056 | P1 | Pos | Action | Fields, confirmation, steps (set fields, step, notify, webhook, create payment, open print) | Runs on the record |
| FT-BLD-057 | P1 | Neg | Automation | `setFields` empty; transition unknown; notify without recipient; SMS without phone recipient; webhook without connector | Each refused ("choose at least one recipient") |
| FT-BLD-058 | P1 | Neg | Automation cron | `* * *`; `60 * * * *` | "Cron needs five fields: minute hour day month weekday"; "Cron value out of range in '…'" |
| FT-BLD-059 | P1 | Bnd | Template | Subject 200 / 201; body 10,000 / 10,001; HTML 50,000 / 50,001; unknown placeholder | Refused at check |
| FT-BLD-060 | P1 | Pos | Template | Preview with a real record; "Send a test to me" | Preview renders; test mail arrives |
| FT-BLD-061 | P1 | Pos | Posting rule | Try on a sample record; unbalanced lines | Balance check shown; "at least one debit and one credit line" |
| FT-BLD-062 | P1 | Pos | Receipt rule | Series, amount, status trigger | Receipt issued when the status is reached |
| FT-BLD-063 | P1 | Pos | Theme (Builder) | Key must be `organisation` | Other keys refused |
| FT-BLD-064 | P1 | Pos | Translation | One per locale; second Hindi translation | "translation 'x' already covers 'hi'" |
| FT-BLD-065 | P1 | Pos | Translations grid | Chip per language with progress; search, Missing only, area filter, 100 rows + Load more; English beside the textarea | Saved text used after publish |
| FT-BLD-066 | P1 | Neg | Translations grid | Remove a `{placeholder}` | Error naming the placeholders; "placeholder lost" badge |
| FT-BLD-067 | P2 | Pos | Translations grid | Entry pointing at a removed field | Stale warning; "Remove stale" |
| FT-BLD-068 [MT-BLD-04] | P0 | Pos | Roles (Administration) | Administration → Roles → Viewer → Permissions; turn one off; Save; open the access map; open `/builder/roles` | Saved at once, nothing to publish; Held by roles on the access map matches the saved permissions; members lose it on their next action; `/builder/roles` and `/builder/roles/:key` redirect to `/admin/roles` |
| FT-BLD-069 [MT-BLD-05] | P1 | Pos | Roles (Administration) | Administration → Roles → New role | Created live with no permissions and no members, on its Permissions tab; nobody gains it automatically |
| FT-BLD-070 | P1 | Pos | Access map | Area chips, search, record-type and held-by filters, Only problems; "No role holds this"; inline edit → Draft badge → Publish all drafts | Drafts saved to each owning definition, published together |
| FT-BLD-071 | P1 | Pos | Access map | "What can Viewer see?" | Summary and live preview of list and panel as Viewer |
| FT-BLD-072 | P1 | Pos | Permission autocomplete | Type `record:don` | Known permissions with where used; a new string still allowed |
| FT-BLD-073 [MT-BLD-06] | P1 | Pos | Modules | Donations lists its definitions; disable (confirm) then enable | Disable keeps records and patches; enable is all-or-nothing |
| FT-BLD-074 | P1 | Neg | Modules | Enable a module whose key collides with an organisation definition; disable a module not on | "The NGO already has its own …"; "Module 'x' is not turned on." |
| FT-BLD-075 | P1 | Pos | Modules | Update review after a product upgrade | Organisation with a non-fitting patch or open draft stays on its version |

### 20.4 Expression editor

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-BLD-080 | P1 | Pos | Type `record.amount - coalesce(record.fee, 0)` | About 400 ms later "valid (number)" |
| FT-BLD-081 | P1 | Neg | `record.amout` | Error with the bad part highlighted; "Use amount" suggestion |
| FT-BLD-082 | P1 | Neg | 2,001 characters; 65 nested brackets; `'abc`; `foo(1)`; `record.__proto__`; `1/0` (Try it); `round('a')`; `'a' < 1` | "Expression is too long"; "…nested too deeply"; "Unterminated text at N"; "Unknown function 'foo'"; "'__proto__' … is not allowed"; "Division by zero"; "round needs a number"; "Cannot compare string with number" |
| FT-BLD-083 | P1 | Pos | ƒx panel; Try it on a sample record and on typed values | Fields and functions insertable; result shown ("Trying…") |
| FT-BLD-084 | P2 | Pos | Functions `len`, `isEmpty`, `contains`, `lower`, `upper`, `trim`, `text`, `abs`, `min`, `max`, `number`, `today`, `now`, `daysBetween`, `addDays`, ternary | Each returns the documented result |

## 21. Runtime engines (`RUN`)

### 21.1 Automations and scheduler

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-RUN-001 | P1 | Pos | Automation on created, updated, statusChanged (to/from), schedule | Each fires once at the right moment; runs as `automation:<key>` in the audit |
| FT-RUN-002 | P1 | Pos | Condition false | Does not fire |
| FT-RUN-003 | P1 | Pos | Actions set fields, run step, create record, notify, webhook, connector | Each performed in order |
| FT-RUN-004 | P1 | Bnd | Automation chain of depth 5, then 6 | Stops at 5 |
| FT-RUN-005 | P1 | Pos | Automation that updates its own record | Does not re-trigger itself |
| FT-RUN-006 | P1 | Pos | Quiet import | No automations |
| FT-RUN-007 | P1 | Pos | Schedule automation created now | Does not replay past schedules |
| FT-RUN-008 | P2 | Pos | Scheduler stopped for 40 days, then resumed | Looks back at most 31 days |
| FT-RUN-009 | P1 | Sec | `POST /internal/tick` without a bearer; with a wrong bearer; `GET` without cron header; with `X-Appengine-Cron: true` from outside App Engine | `403 {"code":"forbidden","message":"Not allowed."}` except the trusted cron path |
| FT-RUN-010 | P2 | Pos | Failed action retried | Actions already done are not repeated |

### 21.2 Outbox, connectors, notifications, templates

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-RUN-020 [MT-CON-01] | P1 | Pos | No organisation connector; trigger an email, an SMS and a WhatsApp message | Email falls back to the installation's mail and is sent through OneNGO's email service; with no installation mail either, nothing is sent and the notification is skipped ("Email is not configured for this organisation."). SMS and WhatsApp have no installation fallback: skipped ("SMS/WhatsApp is not configured for this organisation.") |
| FT-RUN-021 | P1 | Pos | Disabled connector | Delivery "Not sent: the connector is not enabled." |
| FT-RUN-022 | P1 | Pos | Fixture endpoint failing | Retries at 2, 4, 8, 16 minutes; 5th failure permanent; alert `outbox.failed_permanently` |
| FT-RUN-023 | P1 | Pos | Webhook delivery | Signed with `x-ngo-signature`; receiver can verify |
| FT-RUN-024 | P1 | Pos | HTTP send | After commit; 8 s timeout; no redirects followed; error kept to 300 characters with secrets stripped |
| FT-RUN-025 | P1 | Pos | HTTP lookup returning 404; 500; a body over 65,536 bytes | 404 is a field error; failure refuses the save, not retried; oversize refused |
| FT-RUN-026 | P1 | Pos | OAuth token near expiry | Refreshed within 60 s of expiry; failed refresh shows "Reconnect needed" |
| FT-RUN-027 | P1 | Pos | In-app and email notification to a Hindi-language member | Rendered in Hindi (organisation translation, else English); subject at most 200 characters |
| FT-RUN-028 | P0 | Sec | Notification to an external email about a donor with PAN | Every protected field masked |
| FT-RUN-029 | P0 | Sec | HTML template with `<script>`, `<iframe>`, `<style>`, `<svg>`, `<form>`, `<img src=http://…>`, `<a href=javascript:…>`; placeholder value containing HTML | Dropped with content; only https images and http/https/mailto links; placeholder value escaped |
| FT-RUN-030 | P1 | Neg | Notify with an unpublished template | "Template 'x' is not published." |
| FT-RUN-031 | P2 | Bnd | Message text over 1,600 characters to SMS | Capped |
| FT-RUN-032 | P1 | Pos | WhatsApp template | Name, language (default `en`), parameters sent |

### 21.3 Override scripts

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-RUN-040 | P1 | Pos | beforeSave that sets a field | Field set on save |
| FT-RUN-041 | P1 | Neg | validate that calls `ctx.fail("x")` | Save refused with "x" (`script_failed`) |
| FT-RUN-042 | P1 | Pos | afterSave that proposes a notification | Sent after commit; failed delivery does not undo the save |
| FT-RUN-043 | P1 | Neg | workflowGuard refusing | Step refused |
| FT-RUN-044 | P1 | Pos | customButton | Changes record and proposes effects |
| FT-RUN-045 | P1 | Neg | Infinite loop | "Script exceeded its N ms time limit." (`script_limit`); save refused; run logged |
| FT-RUN-046 | P1 | Neg | Allocate a lot of memory | "Script exceeded its memory limit." |
| FT-RUN-047 | P1 | Bnd | `timeoutMs` 9/10/1000/1001; `memoryMb` 0/1/32/33 | Out of range refused at publish |
| FT-RUN-048 | P1 | Neg | Output over 256 KB; 51 log lines; a 600-character log line | "Script output is too large."; logs capped at 50 lines and 500 characters |
| FT-RUN-049 | P0 | Sec | Looping script in org A while org B saves | Org B not stalled; org A hits "…used its script time for the last minute" (S4-2) |
| FT-RUN-050 | P1 | Neg | Two Try it runs at once in one org | Second refused |
| FT-RUN-051 | P0 | Neg | Journal effect unbalanced by 0.01 | "Script '…' effect 1: journal does not balance: debits 1500.00, credits 1499.99" (422); run logged `rejected` |
| FT-RUN-052 | P0 | Neg | Journal to an undeclared account; above `maxTotalAmount`; into a closed year | Refused |
| FT-RUN-053 | P0 | Neg | Script tries to issue or change a receipt, reverse an entry, open or close a year, delete a record | Not possible (no such effect) |
| FT-RUN-054 | P1 | Neg | Undeclared effect type; 21 effects; 51 per save; update the record being saved; create a record of its own type | "the script does not declare 'x' effects"; refused |
| FT-RUN-055 | P1 | Neg | Notification to an address supplied by the script | Refused; only roles, users, creator, record fields, named recipients |
| FT-RUN-056 | P0 | Sec | SCRIPT (no `config:script:admin`) publishes a script with `runAs` or balances; tries it | Refused (S4-8) |
| FT-RUN-057 | P1 | Pos | Finance script publish | Audit `script.published.finance`; admins notified |
| FT-RUN-058 | P1 | Pos | Try it | Writes nothing; capped at 250 ms. Known gap: proposed effects not shown |
| FT-RUN-059 | P1 | Pos | `enabled: false`; rollback to previous version | Script stops running; previous behaviour back |
| FT-RUN-060 | P1 | Sec | Script reads a record the saver cannot see | Looks missing; sensitive fields masked |
| FT-RUN-061 | P1 | Con | Script updating a related record with a stale version | Whole save refused |

## 22. Privacy: consent and erasure (`PRV`, API only)

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-PRV-001 | P1 | Pos | Record consent granted, then withdrawn, for a donor record (purpose `newsletter`, source `form`) | History in order; current state withdrawn |
| FT-PRV-002 | P1 | Neg | Purpose `News Letter`, `1abc`, 65 characters; source `erasure`; state `maybe` | Refused |
| FT-PRV-003 | P1 | Neg | Consent calls without `privacy:consent:record` / `:read` | Refused |
| FT-PRV-004 | P0 | Neg | Erase an active member | "Suspend the person before erasing them." |
| FT-PRV-005 | P0 | Pos | Erase a suspended member who has donations | Pseudonym "Erased person <code>", email `erased-<code>@erased.invalid`; copied donor fields on donations erased; history shows "[erased]"; messages lose address, subject, body; consents withdrawn with source erasure; amounts, numbers, receipts, journals kept; response reports financial records kept and keep-until date |
| FT-PRV-006 | P0 | Pos | Erase again | `200`, same result, nothing changes |
| FT-PRV-007 | P1 | Pos | Erase a member who belongs only to this organisation; erase SHARED | Account pseudonymised and switched off; SHARED account left unchanged in org B |
| FT-PRV-008 | P1 | Neg | Record consent for an erased person | Refused |
| FT-PRV-009 | P1 | Sec | After erasure, search idempotency responses, outbox payloads, job items, import rows, approval data, payment events, connector errors, script run messages | **S4-9 appears open**: record each place the person's data remains |
| FT-PRV-010 | P1 | Pos | Known remaining data | Donor name in journal descriptions; provider payloads; hand-typed unlinked text. Record as accepted residuals |
| FT-PRV-011 | P1 | Pos | `GET /api/admin/export` with `data:export`; without | gzip JSON lines of the whole organisation; audit `data.exported`; refused without |

## 23. Languages (`L10N`)

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-L10N-001 [MT-NAV-10] | P1 | Pos | Walk sign-in, Home, Records, a form, an error, Inbox, Settings, Administration, Builder in each of hi, ta, te, bn, mr | Published strings translated; missing ones in English. UX-005: Settings heading and breadcrumb stay English in Hindi: fail until fixed |
| FT-L10N-002 [MT-NAV-11] | P1 | Pos | Organisation default Hindi; new member's first session and mails | Hindi until they choose |
| FT-L10N-003 | P1 | Pos | Organisation translation of a field label and a template | Shown to Hindi users after publish |
| FT-L10N-004 | P1 | Neg | `PUT /api/me/locale` `xx`, `en-gb` | "'xx' is not a language this organisation offers." |
| FT-L10N-005 | P2 | UI | Long Tamil labels on phone; Indian scripts | No clipping; device fonts (no web fonts loaded) |
| FT-L10N-006 | P2 | Pos | Receipt and print view in Hindi | Translated labels; amounts and dates readable |
| FT-L10N-007 | P2 | Pos | Builder native `confirm()` prompts in Hindi | Buttons in the browser's language (documented gap) |

## 24. PWA and offline (`PWA`)

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-PWA-001 [MT-NAV-12] | P1 | Pos | Go offline on a list and a record | Banner "You're offline. What's on screen stays here, but changes can't be saved until you're back online."; Save and Create disabled in sheet forms |
| FT-PWA-002 | P1 | Neg | Go offline in Administration and Builder; press Save | Known gap: buttons not blocked; expect "Cannot reach the server. Check your connection." and no partial save |
| FT-PWA-003 | P1 | Pos | Back online; save | Succeeds |
| FT-PWA-004 | P0 | Sec | Inspect the service worker cache after browsing records | App shell only; no `/api` responses cached |
| FT-PWA-005 [MT-NAV-13] | P2 | Pos | Deploy a new version; return to the tab | "A new version is ready" with Reload; About shows the new version |
| FT-PWA-006 | P2 | Pos | Offline mid-import, mid-approve, mid-create | Clear error; no duplicate on retry |
| FT-PWA-007 | P2 | UI | iPhone with a notch, installed | Safe-area padding; nothing under the notch or home bar |

## 25. Tenant isolation (`ISO`)

Run with ADMIN in org A and B-ADMIN in org B. Each case is P0. Any leak is a Blocker.

| ID | Type | Steps | Expected |
| --- | --- | --- | --- |
| FT-ISO-001 | Sec | With an A token, request a B record id through get, update, transition, share, receipts, approval, files, print, export | not found / refused; no data |
| FT-ISO-002 | Sec | A's API key against B ids | Refused |
| FT-ISO-003 | Sec | A's search, list, aggregate, and widgets | Only A records; sums exclude B |
| FT-ISO-004 | Sec | Receipt sequences in A and B with the same prefix | Independent sequences; no cross-numbering |
| FT-ISO-005 | Sec | A's definitions, patches, scripts, templates, translations, theme | Invisible and unaffected in B |
| FT-ISO-006 | Sec | A's jobs, notifications, audit, connectors, deliveries | Invisible in B |
| FT-ISO-007 | Sec | A's file id or logo from B | not found |
| FT-ISO-008 | Sec | SHARED signs in to A, then B | Sees only the current organisation's data; each organisation keeps the name it typed (S4-10) |
| FT-ISO-009 | Sec | Script in A tries to read B data | Impossible |
| FT-ISO-010 | Sec | Webhook for A's payment sent with B's organisation key | Refused |
| FT-ISO-011 | Sec | Suspend B; check A | A unaffected |
| FT-ISO-012 | Sec | Same PAN and same registration number in A and B | Allowed (uniqueness is per organisation) |

## 26. Security behaviour visible to a tester (`SEC`)

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-SEC-001 | P1 | Sec | Response headers on app and API | CSP with `script-src 'self'` and `frame-ancestors 'none'`; `X-Content-Type-Options: nosniff`; `Referrer-Policy: no-referrer`; `X-Frame-Options: DENY`; HSTS one year; `Cache-Control: no-store` on `/api` |
| FT-SEC-002 | P1 | Sec | Embed the app in an iframe on another site | Blocked |
| FT-SEC-003 | P1 | Sec | Trigger a server error | `500 {code:"internal", requestId}` only; no stack trace |
| FT-SEC-004 | P1 | Sec | More than 300 `/api` requests per minute from one address | `429` with `retry-after: 60` |
| FT-SEC-005 | P1 | Sec | With proxy not trusted, send `X-Forwarded-For` spoofing another address | Ignored for rate limits (S4-4) |
| FT-SEC-006 | P1 | Sec | Rich text, file names, record titles, notification text with HTML or script | Never executed anywhere (list, panel, print, mail, export) |
| FT-SEC-007 | P1 | Sec | Download an HTML or SVG file through `/api/files/<id>` | Not rendered inline; downloaded with nosniff |
| FT-SEC-008 | P1 | Sec | Change a hidden field in the browser request (role, tenant, `createdBy`) | Ignored or refused; organisation always from the signed-in identity |
| FT-SEC-009 | P1 | Sec | Every write as VIEW by direct API call | Refused; screen hiding is never the only check |
| FT-SEC-010 | P2 | Sec | The app loads nothing from the public internet (fonts, images, scripts) | DevTools network shows only same-origin requests (logo from another site is not loaded) |

## 27. Accessibility behaviour (`A11Y`)

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-A11Y-001 [MT charter] | P1 | UI | Keyboard only: sign in, open a list, filter, open a record, edit, save, approve | Possible with Tab, Enter, Escape; visible focus; Enter opens a focused row |
| FT-A11Y-002 | P1 | UI | Dialogs and panels | `aria-modal`; focus moves in and is trapped; Escape closes; focus returns. UX-003: fail where not |
| FT-A11Y-003 | P1 | UI | Validation failure | Focus moves to the first invalid field (UX-009) |
| FT-A11Y-004 | P1 | UI | Phone touch targets | At least 44 px (UX-004 lists 23 failures) |
| FT-A11Y-005 | P1 | UI | Screen reader on errors and notices | `role=alert` / `role=status` announced |
| FT-A11Y-006 | P2 | UI | Unlabelled controls: API key role selector, layout buttons | Have accessible names (UX-006, UX-007) |
| FT-A11Y-007 | P2 | UI | Reduced motion | No slide animations; Load more visible |
| FT-A11Y-008 | P2 | UI | Status shown by colour | Always with text |
| FT-A11Y-009 | P2 | UI | 200% zoom on desktop | Layout reflows, no lost controls |

## 28. Platform operations (`OPS`)

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-OPS-001 | P1 | Pos | `GET /health`; `GET /ready` with database up and down | `200 {"status":"ok"}`; `200 {"status":"ready"}` / `503 {"status":"unavailable"}` |
| FT-OPS-002 | P1 | Neg | Start the server with PostgreSQL below 15, a bad `INSTALLATION_MODE`, deploy not run, `TOKEN_SECRET` under 32 characters, schema level below the minimum | "Start-up failed", exit code 1 |
| FT-OPS-003 | P1 | Sec | Runtime database login is superuser, has BYPASSRLS, or owns the schema | Start-up refused (S4-14) |
| FT-OPS-004 | P1 | Pos | Deploy with `SHIPPED_MODULES` unset, `donations`, empty | Defaults to Donations; Donations; no modules |
| FT-OPS-005 | P2 | Pos | `fields:reencrypt` after rotating `ENCRYPTION_KEY` with `ENCRYPTION_KEY_PREVIOUS` | Two-step and connector secrets and sensitive fields readable afterwards |
| FT-OPS-006 | P1 | Pos | Alerts on shared test: force a permanent outbox failure, a failed job, 6 unhandled errors in 5 minutes, memory above 300 MB | Each alert fires and closes 30 minutes after the last entry |
| FT-OPS-007 | P1 | Pos | Restore drill: restore a backup, issue a receipt | Numbering continues with no gap or reuse |
| FT-OPS-008 | P2 | Pos | Budgets for the non-functional pass | Memory under 250 MB; cold start under 4 s; p95 save under 500 ms; initial download within 90 kB brotli (last measured 91.4 kB) |

## 29. Guide app (`GDE`)

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-GDE-001 | P2 | Pos | Open `/guide`; walk each section (App, Builder, Sign-in, Org and Connectors) | Each chapter plays; web and mobile modes; auto below 760 px |
| FT-GDE-002 | P2 | Neg | Unknown section or chapter in the address | Redirects to the first valid chapter |
| FT-GDE-003 | P2 | Pos | Guide wording versus the live app | Labels match; file each mismatch as Minor |

## 30. End-to-end journeys (`E2E`)

Each journey is P0 and runs across roles and both apps. Record a pass only when every step passes.

| ID | Journey | Steps | Expected end state |
| --- | --- | --- | --- |
| FT-E2E-01 | Open a new NGO | OP-FULL validates and provisions; Asha accepts the invitation; completes identity, registrations, receipt series review; invites FIN and VIEW | Setup is complete; audit shows each step |
| FT-E2E-02 | Donation to receipt | FIN creates donor and donation; Mark as paid by UPI with reference; prints receipt; copies public link; donor opens it signed out | Receipt `RCPT/<fy>/00001`; balanced posting; donor totals updated; public link works |
| FT-E2E-03 | Online gateway payment | FIN creates donation; Pay now through Razorpay fixture; captured webhook | Paid automatically; one receipt; duplicate webhook ignored |
| FT-E2E-04 | Approval journey | CONFIG adds a 2-approval step and publishes; FIN requests; approver 1 approves; approver 2 approves from Inbox | Step applied; requester notified; audit complete |
| FT-E2E-05 | Bulk migration | ADMIN imports 1,000 donors from CSV with Indian numbers and dates; then imports updates by PAN; exports; bulk-adds a role to 60 people | All counts match; failed rows downloadable; jobs visible |
| FT-E2E-06 | New module without code | CONFIG creates two related record types, list views, a group, a 2-step workflow with approval, a template and automation, a home widget; publishes | Members use it the same day; nothing in old records changed |
| FT-E2E-07 | Year end | Donations paid on 31 March and 1 April | Numbers restart for the new year; old year untouched |
| FT-E2E-08 | Incident | OP-FULL suspends; members and keys refused; reactivates; members sign in again; new key issued | No data lost; old sessions and keys dead |
| FT-E2E-09 | Erasure request | ADMIN suspends a member; PRV erases them | Personal data gone; money records kept; residuals recorded (S4-9) |
| FT-E2E-10 | Integration | ADMIN creates an API key; an external system queries donors and creates a donation with `Idempotency-Key`; webhook connector notifies an external endpoint | Data masked per role; no duplicate on retry; signed webhook received |
| FT-E2E-11 | Closure | OP-FULL suspends then closes | Sign-in refused permanently; data retained |

## 31. Exploratory charters

Time-box each to 45 minutes; note persona, record type, and findings.

| Charter | Focus |
| --- | --- |
| Permission edges | Share grants edit while role grants read; ended share; field-level permissions with bulk and import; access map against reality |
| Two people, one record | Simultaneous edits, steps, approvals, shares, imports |
| Money boundaries | Amount 1, very large, fee 0 and equal; paid on first and last day of the year; midnight in IST vs UTC |
| Address is the state | Reload, share links, Back/Forward through every panel mode and create step |
| Language and long text | Each language, 200-character names, 500-character reasons, receipts |
| Offline and flaky network | Throttle to slow 3G; drop mid-request on every write |
| Builder breakage | Publish odd but valid definitions; remove things in use; restore old versions |
| Script misuse | Try every way to escape the sandbox rules from a script author's seat |

## 32. Known defects, gaps and conflicts to decide

**Decided**

| Ref | Decision | Cases |
| --- | --- | --- |
| D-01 | The people list is shown only at Administration → People. There is no `/people` route. It is not a destination in the bar, the overflow menu, Home, or Settings. Decided 2026-11-03; no `/people` route, 2026-11-04. | FT-ADM-040, FT-NAV-005, FT-NAV-016, MT-NAV-01, MT-NAV-02, MT-PPL-01, MT-PPL-02 |
| D-02 | More is not a screen and not a backend concept. The server stores one navigation order. The phone and the rail fold links that do not fit. Decided 2026-11-03. | FT-NAV-002, FT-NAV-003, FT-NAV-016, FT-NAV-018, FT-NAV-019, FT-BLD-055, MT-NAV-01, MT-NAV-04 |

**Defects to confirm or fix**

| Ref | Finding | Case |
| --- | --- | --- |
| K-15 | The backend still has a More place. Page `placement` is `home` or `more` (`packages/product/schemas/page.schema.json`). The layout setting still accepts a `more` list (`packages/platform/src/runtime/definitions/appearance.ts`). Before folding, the app builds a default More group from pages placed in More plus Administration, Builder, Settings and Sign out (`defaultMore` in `apps/onengo/web/src/app/core/shell/shell.ts`). New layout publishes already send an empty `more` list. | FT-NAV-019 |
| K-02 | `unique` accepted on person fields though the message names only text, email, phone, number | FT-BLD-033 |
| K-03 | S4-9: erasure leaves personal data in side tables | FT-PRV-009 |
| K-04 | UX-001 to UX-015 from the 2026-11-01 audit (theme loads black, profile "Not found.", focus, touch targets, Hindi Settings heading, labels, connector panel address, required marks, fee message placement, raw audit keys, Select on empty list) | FT-ADM-130, FT-SET-001, FT-A11Y-*, FT-L10N-001, FT-DON-022, FT-ADM-102 |
| K-05 | Searches on Jobs, Audit, Roles, role members, Connectors filter only loaded rows | FT-ADM-057 |
| K-06 | Share removal, empty pin name, and no-change saves have no confirmation or message | FT-REC-134, FT-HOME-014, FT-ADM-122 |
| K-07 | Builder and module prompts use native `confirm()` (unthemed, browser language) | FT-L10N-007 |
| K-08 | Offline save not blocked in Administration and Builder | FT-PWA-002 |
| K-09 | Windows Chrome installed icon shows a letter | FT-SET-005 |
| K-10 | Invitation subject lacks "on OneNGO"; authenticator label "NGO Platform:<email>" | FT-AUTH-070, FT-AUTH-092 |
| K-11 | Display name: screen allows 200, onboarding caps at 120 | FT-ADM-111 |
| K-12 | Web download budget 91.4 kB against 90 kB; test threshold raised without agreement | FT-OPS-008 |
| K-13 | Can a person field hold an invited member (save accepts, picker does not)? | FT-REC-082 |
| K-14 | `today` in rules is a UTC date: possible refusal of same-day payments early in the IST morning | FT-DON-028 |

**Document conflicts that need a product decision before expected results are final**

| Ref | Conflict |
| --- | --- |
| C-01 | My profile: editable self-service fields (person document, R1 B25) versus read-only (Settings wireframe, built) |
| C-02 | More versus Settings: approved design puts language, two-step and About in More; built app uses `/settings` (UX-015) |
| C-03 | Product name: "NGOOne" (some wireframes, UI design §3) versus "OneNGO" |
| C-04 | Website: http or https (organisation document) versus https only (user guide) |
| C-05 | Operator console: enhancement document says not started; it is built |
| C-06 | Release 2 plan header says planned; R2-B01 is built, R2-B02 is not |

## 33. Passkeys (pending merge of `features/passkey-authentication`)

Run only after the branch merges. Expected results come from the design on that branch.

| ID | Pri | Type | Steps | Expected |
| --- | --- | --- | --- | --- |
| FT-PK-001 | P0 | Pos | Organisation policy `passkey_enabled` off (default) | No passkey option anywhere; `/api/auth/passkey/available` false |
| FT-PK-002 | P0 | Pos | Policy on; signed-in member saves a passkey from Settings (name empty) | "Passkey saved."; named "Passkey"; audit `passkey.added` |
| FT-PK-003 | P1 | Bnd | Name 60 / 61; 10 passkeys then an 11th | Over-limit refused |
| FT-PK-004 | P1 | Neg | Device without a platform authenticator | "This browser cannot save passkeys on this device." |
| FT-PK-005 | P1 | Pos | Cancel the device prompt | Settings unchanged, no error |
| FT-PK-006 | P0 | Sec | Member with two-step on saves or removes a passkey | Requires password and code: "Enter your password and a code from your authenticator app to change passkeys." |
| FT-PK-007 | P0 | Pos | "Sign in with this device" | Signs in without typing an email; with two-step on, stops at the authenticator step (passkey button hidden) |
| FT-PK-008 | P0 | Sec | Any passkey failure | "Passkey sign-in did not work. Try again, or use your password or an email code." |
| FT-PK-009 | P0 | Sec | Challenge older than 300 s; reused; from org A used at org B | Refused |
| FT-PK-010 | P1 | Sec | More than 30 ceremony calls per address in 15 minutes | Rate-limited |
| FT-PK-011 | P1 | Sec | Cloned authenticator with a stalled counter | Refused; audit `passkey.counter_rejected` |
| FT-PK-012 | P0 | Pos | Remove a passkey | "Passkey removed."; passkey sessions in this organisation end; password sessions stay; audit `passkey.revoked` |
| FT-PK-013 | P0 | Pos | Turn the policy off | Passkey sessions end; password sessions stay |

## 34. Suites

### 34.1 Release smoke (run first; any P0 fail stops the candidate)

`FT-OPC-001`, `FT-OPC-040`, `FT-OPC-070`, `FT-OPC-080`, `FT-AUTH-004`, `FT-AUTH-020`, `FT-AUTH-060`, `FT-AUTH-065`, `FT-AUTH-100`, `FT-NAV-005`, `FT-HOME-001`, `FT-REC-043`, `FT-REC-047`, `FT-REC-109`, `FT-WF-021`, `FT-WF-024`, `FT-DON-020`, `FT-DON-026`, `FT-DON-035`, `FT-DON-037`, `FT-DON-040`, `FT-FIN-028`, `FT-FIN-069`, `FT-ADM-028`, `FT-ADM-080`, `FT-ADM-082`, `FT-BLD-007`, `FT-ISO-001`, `FT-OPC-087` (on a disposable organisation).

### 34.2 Regression

| Trigger | Run |
| --- | --- |
| Any change | Smoke |
| Sign-in or session code | Section 11 in full, FT-OPC-016, section 25 |
| Records, fields, definitions | Sections 14, 15, 20, FT-ISO-* |
| Money, receipts, payments | Sections 16 and 17 in full, FT-E2E-02, FT-E2E-03, FT-E2E-07 |
| Administration or people | Section 18, FT-AUTH-103 |
| Connectors, templates, scripts | Section 21 |
| Web shell or layout | Sections 12, 13, 24, 27 |
| Release candidate | Every P0 and P1 |

## 35. Schedule, roles, risks

**Suggested order** (lifecycle closes organisations, so it is last):

1. Operator onboarding (10.1–10.5).
2. Sign-in (11).
3. Shell and Home (12–13).
4. Administration setup (18).
5. Builder: build the full-field test type and the approval workflow (20).
6. Records, workflows, Donations, finance (14–17).
7. Runtime, privacy, languages, offline, isolation, security, accessibility (21–27).
8. Journeys (30).
9. Lifecycle (10.6).

| Role | Responsibility |
| --- | --- |
| QA Manager | Plan, gates, decisions on section 32 with the Product Owner |
| Functional testers (2) | Sections 10–24, 29, 30 |
| Security-minded tester | Sections 25–26 and every `Sec` case |
| Accessibility tester | Section 27 |
| DevOps | Shared environment, IAP, alerts (FT-OPS-006), restore drill |

| Risk | Mitigation |
| --- | --- |
| Mail or provider sandboxes missing on shared test | Use the integration fixture locally; mark Blocked, never Pass |
| Operator IAP and fresh MFA hard to arrange | Book an operator account with a provider that reports `amr` and `auth_time` before the run |
| Expected results drift with open conflicts (C-01 to C-06) | Decide before execution; update this plan |
| Data destroyed by lifecycle cases | Use a disposable organisation for close |

## 36. Traceability

| Area | Source documents | Code |
| --- | --- | --- |
| Operator console | ONE_NGO_VERSION_2_ENHANCEMENT, organisation business document | `apps/onengo-console`, `packages/platform/src/application/organisations` |
| Sign-in and identity | User guide, S4 review, organisation document | `apps/onengo/server/src/http/plugins/auth.ts`, `packages/platform/src/application/identity`, `packages/platform/src/domain/identity` |
| Shell, Home, Records UI | UI design, wireframes | `apps/onengo/web/src/app`, `packages/web-kit` |
| Record rules | Release 1 blocks | `packages/platform/src/runtime/records`, `packages/product/schemas` |
| Workflows and approvals | UI design §7, user guide | `packages/platform/src/runtime/workflows` |
| Donations | UI design §8 | `packages/product/modules/donations` |
| Finance | Financial year and payment gateway documents | `packages/platform/src/domain/{receipts,ledger,accounts,payments}` |
| Administration | UI design §8b | `apps/onengo/web/src/app/admin`, `apps/onengo/server/src/http/plugins/admin.ts` |
| Builder | Builder wireframes | `apps/onengo/web/src/app/builder`, `packages/platform/src/runtime/definitions` |
| Runtime engines | Connector runtime, script effects design | `packages/platform/src/runtime/{automation,scripts}`, `packages/platform/src/application/{connectors,notifications}` |
| Privacy | Consent and erasure document | `packages/platform/src/application/privacy` |
| Operations | DevOps handover, monitoring | `apps/onengo/server/src/deploy.ts`, `docs/operations/monitoring` |

## 37. Results sheet

| Field | Value |
| --- | --- |
| Environment | |
| Organisation app / operator console | |
| Version and schema level | |
| Browsers and viewports | |
| Organisation codes | |
| Tester | |
| Date | |

| ID | Result (Pass / Fail / Blocked / Not run) | Defect | Notes |
| --- | --- | --- | --- |
| | | | |
