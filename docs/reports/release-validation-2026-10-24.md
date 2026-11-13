# Release validation — release 1, all phases — 2026-10-24

Code: worktree `wt-b45`, branch `b45` (from master `e22ac07`). Commits: `fddff30`, `50f6fee`, `665d19c`, `2191351`.
Sources: `.cursor/docs/design/ngo-app-ui-design.md`, `.cursor/docs/architecture/ngo-app-ui-implementation.md`, `.cursor/docs/design/wireframes/ngo-app-navigation-flows.html` (Journeys 1–23), `.cursor/docs/design/wireframes/ngo-builder-screens.html` (Builder 1–27).

## Result

**PASS WITH EXCEPTIONS (pending manual sign-off).** All 47 automated checks and every review checkpoint pass, and all 1,079 tests pass with none skipped. The manual checkpoints and the visual walkthrough need a person in the running app (checklist below). Two exceptions need your agreement.

## Summary

| Area | Pass | Fail | Waiting for manual check |
| --- | --- | --- | --- |
| A. Architecture rules (A1–A10) | 10 | 0 | 0 |
| S. Server (S1–S32) | 36 | 0 | 0 |
| W. Web app (W1–W25) | W1, W3, W4, W5, W16 (files), W25; W6–W10 and W15 in code and tests | 0 | W6–W24 on screen |
| B. Builder (B1–B11) | 4 (B2, B4, B8 files, B9 code) | 0 | B1, B3, B5–B11 |
| P. Installable app (P1–P3) | 2 | 0 | P3 |
| C. Commands and budgets (C1–C4) | 4 | 0 | 0 |
| D. Documentation (D1–D3) | 3 | 0 | 0 |
| V. Visual walkthrough (V1–V12) | 0 | 0 | 12 |

## Failures fixed during validation

| ID | Was | Fix |
| --- | --- | --- |
| C4 | FAIL: "builder not found in build output". The check parsed Angular's build table, which lists only the 15 largest lazy chunks and has no single Builder chunk. | The check now measures the built files (brotli, like `test/web-build.test.ts`). An area's chunk is every file reachable from its route entry that no other area reaches, plus its English text, so all Builder screens and editors count together. This is never less than the old per-entry figure. Budgets unchanged. `--sizes` prints the breakdown. |
| C2 | Ran before the build, so the 7 production-build tests were skipped and still counted as a pass. | The check builds first, then runs `vitest --maxWorkers=3`, and fails when any test is skipped. 1,079 of 1,079 pass. |
| S21 | Bulk operations (`POST /api/records/:type/bulk`) and approval decisions (`POST /api/approvals/:id/decision`) validated the body before identifying the caller, so a signed-out caller got 422 instead of 403. | They now authenticate first (`src/http/server.ts`). New `test/route-guard.test.ts` calls every `/api/` route in the server (more than 100) without credentials, with and without a body, and expects 401 or 403. Only `/api/auth/*` is public. Fake bearer tokens and API keys are refused too. |

## Exceptions for your agreement

| ID | Reason | Agreed by |
| --- | --- | --- |
| C4 (interpretation) | The budgets are applied to each area's own code. Lazy chunks shared by several areas (Material and form controls 69.2 kB, the record panel 23.4 kB, 182.5 kB in all) are reported separately and paid once by whichever list opens first. Measured as full first-open cost instead, records is 181.8 kB (budget 130) and inbox 143.1 kB (budget 60). See `release-sizes-2026-10-24.md`. | — |
| Hosted PostgreSQL | All tests run on PGlite. The `pg_trgm`-missing search fallback (S10) is in migration 007 and logged at start-up, but no test exercises it because PGlite always has the extension. Run the suite with `TEST_DATABASE_URL` against hosted PostgreSQL, with and without `pg_trgm`, before the pilot. | — |

Risk, not an exception: the initial download is 89.5 of 90 kB.

## Commands

| ID | Result | Notes |
| --- | --- | --- |
| C1 | PASS | `npx tsc --noEmit` and `npx tsc -p web/tsconfig.app.json --noEmit`, no errors |
| C3 | PASS | `npm --prefix web run build` |
| C2 | PASS | `npx vitest run --maxWorkers=3`: 1,079 passed, 0 skipped (start of block: 1,068 + 7 skipped) |
| C4 | PASS | initial 89.5/90, records 22.4/130, inbox 5.2/60, builder 125.4/180 kB |
| Locale | PASS | `node web/scripts/locale-areas.mjs --check`: "Screen text is split by area." |
| Release check | PASS 47 · FAIL 0 · SKIP 0 | `check-release.mjs --root wt-b45 --phases all --run` |

## Review checkpoints (evidence)

| ID | Result | Evidence |
| --- | --- | --- |
| A7 | PASS | `test/web-architecture.test.ts`: "the literal-text check catches English…", "templates outside locale/ contain no literal English words" |
| A9 | PASS | No screen or component imports `Router` or a gateway. The Builder matches are type-only imports (`modules.screen.ts`, `generic/*-preview.ts`) or an injectable store (`editors/translations/translation-sources.ts`); also `web-architecture.test.ts` "keeps the shell and More screens off the router and the gateways" |
| A10 | PASS | `app-breadcrumb` appears only in `shell/shell.screen.ts` (and its definition `ui/breadcrumb.ts`); test "draws one breadcrumb, in the shell" |
| S5 | PASS | `src/metadata/cross-refs.ts` (copy rules, related sections, groups, actions, pages, translations; typed options per field type) |
| S8, S17, S18 | PASS | `test/save-pipeline.test.ts` (copy-from order and permission, rollups on create, update, delete and re-point, unique with blanks), `test/field-types.test.ts` |
| S10 | PASS (review) | `migrations/007_ui.sql` lines 4–26, `src/platform.ts` line 154, `test/indexes.test.ts` "use the trigram index for search"; fallback without `pg_trgm` not exercised (see exceptions) |
| S12, S14, S16, S23, S26, S27 | PASS | `test/approvals-query.test.ts`, `record-actions.test.ts`, `connectors.test.ts`, `jobs.test.ts`, `files.test.ts`, `sharing.test.ts` |
| S19b–S19d | PASS | `test/people-admin.test.ts`, `people-profiles.test.ts`, `people-pick.test.ts`, `fine-permissions.test.ts`, `admin-screens.test.ts` |
| S21 | PASS (fixed) | `test/route-guard.test.ts`; per-permission refusals in each area's tests |
| S22 | PASS | `src/http/server.ts` `APP_SHELL_FILES` no-cache, hashed assets immutable; `test/web-build.test.ts` checks the headers; CSP unchanged |
| S31, S32 | PASS | `test/workflows-model.test.ts`, `test/workflow-automation.test.ts` |
| W5, W15, W25 | PASS | `web/src/app/routes.ts` (redirects for `/records/:type/:id` and `/new`), `core/**/address` tests, `core/breadcrumbs.test.ts` |
| W6–W10 | PASS (code) | One record list screen (`web-architecture.test.ts` "routes every record list to the one record list screen"), parity tests `records/parity.test.ts`, `inbox/parity.test.ts`; on-screen behaviour is in the manual checklist |
| B2 | PASS | `builder/editors/generic/schema-form.test.ts` round trip for all module definitions |
| B9 | PASS (code, fixed) | The workflows list is now also the record type editor's Workflows tab (`?tab=workflows`, hidden for the person profile); the location and signature field panel options now reach the app controls |
| D1 | PASS | `ngo-app-ui-implementation.md` status "implemented, 2026-10-24", 1,079 tests |
| D2 | PASS | `ngo-management-platform.md` implementation-status table: three release 1 rows, follow-ups updated |
| D3 | PASS | `release-sizes-2026-10-24.md` and this report |

## Follow-ups from the blocks

| Follow-up | State |
| --- | --- |
| B30 controls read the B38 field options | **Done** (`50f6fee`). Location hides "Type coordinates" when `typedCoordinates` is false. Signature shows the signer's name box only when `typedName` is true; before this it always showed. Test in `core/records/field-types.test.ts`. |
| B39 workflows list inside B38's record type editor | **Done** (`665d19c`). Workflows tab between Rules and Used by; choosing a workflow or adding one opens the workflow editor. |
| `viewport-fit=cover` | **Done** (`2191351`). `index.html`, with left and right safe-area padding on `body`; top and bottom were already padded (app bar, bottom nav, sheets, update prompt). Asserted in `test/web-build.test.ts`. |
| B34 bulk Share should reuse B33's `ui/share-panel` | **Listed.** Not cheap. The share panel lists one record's current shares, which doesn't apply to a selection. Bulk share's form comes from core logic (`core/records/selection.ts` `operationFields`), where a role is typed as a key. Suggested: a "principal" mode of `ui/share-panel` without the shares list, fed by `share-store`'s people-and-roles source. |
| Editor-frame "visual editor coming soon" branch | **Listed for deletion** (below). Every kind now has a visual editor. The branch can still flash "edited as JSON for now" while an editor's chunk loads. |
| B43 role view uses `ui/role-preview`; B40's `ui/live-preview` is the shared control | **Note for later.** Converge the role view on `ui/live-preview`, then `ui/role-preview` becomes a deletion candidate. |
| Naming | `builder/editors/translations/translation-sources.ts` is a store; renaming it to `translation-sources-store.ts` would follow the naming rule (no behaviour change). |

## Deletion candidates (not deleted; need approval)

1. `web/src/app/builder/editor-frame.ts` lines 91–94: the `@else` branch showing `ui.builder.visualSoon` plus a JSON editor on the Visual tab.
2. The key `ui.builder.visualSoon` in `web/src/locale/en.builder.json` (line 270) and its five entries in `web/src/locale/untranslated.json`.
3. Later, after the role view moves to `ui/live-preview`: `web/src/app/ui/role-preview.ts`.

## Discrepancies found (server vs app)

- `typedCoordinates: false` is applied by the app only. The server cannot tell typed coordinates from device ones, so a direct API caller can still send any valid coordinates. This is acceptable: it's a capture preference, not a security rule.

## Business documents (workspace rule)

`legacy/legacy-docs/business/` holds documents for the other product (the be/fe monorepos). None describes an NGO Platform release 1 capability. New NGO Platform business documents belong in `ngo-platform/docs/business/`. Capabilities without a business document:
record types, fields and field options (including location, signature, rich text, file, person); workflows (several per record type) and approvals; record lists, record panel and record groups; record actions and the receipt print view; Home, pages and pins; translations and languages; connectors (SMS, WhatsApp, webhooks); import and export; files; record sharing and restricted visibility; bulk operations; people directory, profiles and My profile; roles, fine-grained permissions and the access map; API keys and the public API; background jobs; audit log and organisation settings; the Builder (drafts, publish, history, modules); the installable app; donors and fundraising (Donations module 0.2.x; `finance/donation` describes the other product).

## Visual walkthrough

Not done here: no browser or dev server was available. Use the manual checklist below and record differences with the step ID (for example "Journey 3, desktop: footer shows Edit before Mark as paid").

| Step | Phone 390 | Tablet 900 | Desktop 1280 | Notes |
| --- | --- | --- | --- | --- |
| V1–V12 | — | — | — | Waiting for sign-off |

## Manual checklist (in order)

**Setup.** Build (`npm --prefix web run build`) and start the API server serving `web/dist/web/browser`, the way you usually run it, so the service worker is active. Sign in as an administrator of an organisation with the Donations module 0.2.1 and sample data. Keep a second browser profile signed in as a Viewer and one as Finance. Use the browser's device toolbar at **390**, **900** and **1280 px** for every row marked "all sizes". Wireframes: Journey n = `ngo-app-navigation-flows.html`, Builder n = `ngo-builder-screens.html`.

### App

| # | Open | Check | Expected | Ref |
| --- | --- | --- | --- | --- |
| 1 | `/sign-in`, sign in | Sign-in screen, then Home | No app bar, nav or breadcrumb on sign-in; Home after sign-in; no external requests in the network tab | Journey 1 (1.1–1.2), V1 |
| 2 | Home, all sizes | Widgets, pins, record groups | Widgets two per row on wide, one on phone; pins above the widgets; record-type lists show no counts | Journey 10, W7 |
| 3 | Navigation, all sizes | Bottom bar at 390, rail at 900 and 1280 | Four destinations; Inbox badge counts approvals only | W6 |
| 4 | Every route, all sizes | Breadcrumb | Starts at the destination (no "Home"); phone shows first · … · last; all but the last are links that keep list parameters; `aria-current` on the last; none on sign-in, reset password and print | W24 |
| 5 | Records → Donations, all sizes | Chips, search, filters and pills, sort, scroll, Back | Address changes on each; Back and a pasted link restore it; cards on phone with no Cards/Table switch; switch on wider screens | Journey 2 (2.1–2.8), V2, W8 |
| 6 | Open a donation, run a step, Back | Panel and footer | One column, centred up to 720 px on wide; steps, then actions, then Edit; Back closes the panel | Journey 3 (3.1–3.4), V3, W9, W10 |
| 7 | Row ⋮ → Edit, save | Edit in the panel | Locked fields follow the record state; "Saved" | Journey 4 (4.1–4.3), V4 |
| 8 | Create a donation with the donor picker | Picker search, "New donor", copied fields | Copied fields lock; clearing the donor unlocks them | Journey 5 (5.1–5.5), V5, W11 |
| 9 | Donors → a donor | Related donations | Count and total from the server, latest ten, "New donation for this donor" | Journey 6 (6.1–6.2), V6, W12 |
| 10 | Inbox, all sizes | Approvals and Notifications chips; approve; reject with reason | Cards on phone, table wider with the common workflow fields; reject reason panel; badge drops | Journey 7 (7.1–7.6), V7, W13 |
| 11 | More | Account card, language, sign out | Account card opens My profile (`?panel=profile`) | Journey 9 (9.1), V9 |
| 12 | More → language → Hindi, then the other four | Text and formats change without reload | Indian number and date formats; organisation labels translated where set, English otherwise; choice follows to another device | Journey 12, W14 |
| 13 | More → a page | `/pages/:key` | Only people in the audience see it | Journey 11 |
| 14 | Record actions (Send reminder, Pay now, Print receipt) | Footer and row ⋮ | Shown only when `when` and permission allow; form and confirmation in the panel; message afterwards | Journey 13, W10 |
| 15 | Print receipt | `/print/receipt/:id` | Paper layout, browser print dialog, no shell, nothing loaded from outside | Journey 14 |
| 16 | List ⋮ → Import CSV; then Export | Five-step stepper | Upload, map, check without saving, run with progress, result with failed-rows CSV; export downloads the current list | Journey 15, W16 |
| 17 | Beneficiary file field, phone and desktop | Choose, drag and drop, camera on phone, progress | Image and PDF previews, downloads | Journey 16, W17 |
| 18 | Restricted record → ⋮ Share | Share panel | People and roles, Can view or Can edit, end date; "Shared with me" chip appears for the other person | Journey 17, W18 |
| 19 | Select rows (table checkboxes, long-press or Select on cards), "Select all matching" | Bulk bar | Only operations allowed for every selected record; results summary; job progress above 50 records | Journey 18, W19 |
| 20 | Location field (default) and one with "Allow typed coordinates" off | Use my location; Type coordinates | Accuracy badge; Type coordinates link absent when the option is off; Open in maps; near filter | Journey 19, W20 |
| 21 | Signature field (default) and one with "Ask for a typed name" on | Pad, Clear, signed by/at | Name box only when the option is on; saved signature shows signer and time, also in the print view | Journey 19, W20 |
| 22 | Rich-text field | Toolbar; paste from a web page | Bold, italic, underline, lists, heading, quote, link; pasted styles and scripts removed | Journey 19, W20 |
| 23 | Record with two workflows | Status lines, footer groups | One status line per workflow; steps grouped, primary first; parallel workflow chips and columns | Journey 20, W21 |
| 24 | As Viewer: More → People · directory | `/people` | Active people, roles, directory fields; no chips, +, ⋮ or selection | Journey 21, W22 |
| 25 | As admin: More → Administration → People and Roles | `/admin/people`, `/admin/roles` | Status chips; add with profile fields; person panel with roles, resend, suspend confirmed in the panel, reactivate; role members with Remove and Add people; link to Builder 18 | Journey 21, W22 |
| 26 | More → account card → My profile | Self-editable fields only | Others "Set by your administrator" | Journey 22, W22 |
| 27 | Administration → connectors, API keys, jobs, audit log, settings | Each area | Secrets shown as set or not set, Test, deliveries with Retry now; API key secret shown once and never in the address; jobs with Cancel; audit read-only with filters; settings with storage use against the quota; each area only with its permission | Journey 23, W23, V12 |
| 28 | iPhone (or Safari responsive mode with a notch) portrait and landscape | Safe areas after `viewport-fit=cover` | Nothing under the notch or home indicator; app bar and bottom nav padded; landscape content clear of the notch | follow-up, Design §10 |

### Builder (tablet 900 and desktop 1280; phone 390 for row 29 only)

| # | Open | Check | Expected | Ref |
| --- | --- | --- | --- | --- |
| 29 | `/builder` at 390 | Phone view | Catalogue and read-only summaries; editors say "Editing works best on a tablet or computer" | B7 |
| 30 | `/builder` | Catalogue chips, search, table | Links to `/admin/connectors` and `/admin/api-keys`; no Builder screens for API keys, connectors or storage | Builder 1, B8 |
| 31 | A record type | General, numbering, fields table, field panel; Rules; **Workflows** tab; Used by | Workflows tab lists the type's workflows with role, condition, "Applies to"; choosing one opens its editor; no Workflows tab on Person profile | Builder 2, 3, 5, 23, B4, B9 |
| 32 | Field panel for location and signature fields | "Allow typed coordinates", "Ask for a typed name" | Saved as drafts; after publish the app follows them (rows 20–21) | Builder 3, B9 |
| 33 | Any expression | Suggestions, live check, Try it | Errors from the server check; Try it shows a result | Builder 4, B3 |
| 34 | A workflow, a step | Diagram, step panel | Diagram updates while editing | Builder 6, 7 |
| 35 | A list view | Live preview phone and desktop; related section; create steps | Preview follows edits | Builder 8, 9, 10 |
| 36 | Record groups | Arrange groups, publish | Home and Records follow | Builder 11, Journey 8, V8 |
| 37 | Template, automation, posting and receipt rules, script, theme, action | Generic editors with previews | Template preview with a real record; script and posting-rule try; theme contrast check | Builder 12–16, 21, B5 |
| 38 | Changes, publish, history, restore, revert to module version | Editor frame | Visual, JSON, Changes, History tabs; autosave; Check; publish summary | Builder 17, B1 |
| 39 | Roles, a role | Permission grid | Name, two-step, grid with "See people" and permission strings in use; member count read-only, links to `/admin/roles/<key>`; no members tab | Builder 18, B6 |
| 40 | Modules | Turn on or off, review update | Update review lists the changes | Builder 19, B6 |
| 41 | Page editor | Widgets with live preview | Real figures in the preview | Builder 20 |
| 42 | Translations | Language, "only missing", type in the grid | App text and organisation text with English beside | Builder 22 |
| 43 | Access map, then "What can Viewer see?" | Filters, inline change, warnings | Permissions no role holds are warned; inline changes saved as drafts of each definition and published together; role view with summary and live preview | Builder 24, 25, B11 |
| 44 | Field, section, widget and link permissions; Person profile fields | Permission autocomplete; Self-editable and In directory switches | Generated and used permissions, new text allowed; switches only on `person`; `person` field type offered everywhere | Builder 26, 27, B10 |

### Installable app

| # | Open | Check | Expected | Ref |
| --- | --- | --- | --- | --- |
| 45 | Chrome and Edge | Install | Install prompt; standalone window with the icon and theme colour | P3 |
| 46 | Deploy a second build while the app is open | Update prompt | "New version" prompt; reload picks it up | P3 |
| 47 | DevTools → offline on a record list | Offline banner | Last list stays visible; saves are blocked with a message; `/api` never served from the cache | P3 |

## Not checked

- Everything in the manual checklist above (needs a person in a running app; no browser or MCP tools are allowed here).
- Hosted PostgreSQL runs (see exceptions).
