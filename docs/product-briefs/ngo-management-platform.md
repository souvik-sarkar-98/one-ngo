# JADx Product Brief — Configurable NGO Management Platform

Status: Final, 2026-10-18. Open items are listed in Section 6 and in Assumptions, Gaps, and Risks.

This brief absorbs the earlier draft "NGO Operations and Statutory Audit Platform" (`legacy/legacy-docs/product-briefs/ngo-operations-statutory-audit.md`). Statutory books becomes one module of this product.

## 1. Capability Definition

**Working Title / Feature Name:** Configurable NGO Management Platform. Every existing feature is rebuilt as a configurable module. New modules are created by administrators without code, and admin-written override scripts cover what configuration cannot.

**Audit Phase:** Not an audit-phase capability. The product covers an NGO's full operating cycle: members, money, programmes, assets, communication, and governance. Statutory year close and the chartered-accountant handover (1 April to 31 March) is one module inside it, carried over from the earlier brief.

**Primary Objective:** Replace the current hand-coded NGO system with a lightweight product. A single NGO can run it on Google App Engine mostly within the free tier. It delivers every existing feature plus new NGO capabilities. After launch, NGOs add or change modules, record types, forms, pages, workflows, rules, notifications, documents, and reports through configuration. When configuration is not enough, they add override scripts. No code release is needed. The current system is retired once the new product reaches feature parity.

## 2. Problem Framing

**Problem Statement:** Every feature in the current system is hand-coded. Every new field, rule, approval step, report, page, or module needs a developer, a build, and a deployment. NGOs cannot change how they work without paying for development. The system also depends on always-on paid services: a cache, a job queue, a managed database, and outside sign-in and push-notification providers. That is more running cost than small nonprofits will accept.

**Who Has This Problem?**

- NGO administrator — sets up the organisation and creates or changes modules, record types, forms, pages, workflows, rules, roles, and templates without developers.
- Script author, a trusted administrator role — writes and publishes override scripts for behaviour that configuration cannot express.
- Office bearers and board (president, secretary, treasurer) — approve, govern, sign statements, and review dashboards.
- Finance operators and receipt clerks — record donations, expenses, earnings, transfers, and invoices, and issue receipts.
- Programme and project managers, and field staff — run projects, activities, beneficiaries, goals, and risks, often on low-end phones with poor connectivity.
- Members and volunteers — keep their profile, raise requests, claim expenses, attend meetings, sign up for volunteer shifts, and log hours.
- Donors and the public — give online, check membership numbers, read public pages, submit public forms, and subscribe to newsletters.
- External chartered accountant — read-only access to download the statutory handover pack and the ledger-name export.
- Platform maintainer (us) — publishes the product, starter templates, and modules that NGOs install into their own Google Cloud project. Also runs a shared installation for NGOs that prefer not to manage their own, and provisions and separates NGOs on it.

**Why It Matters (Impact):**

- Lower cost of change: NGO staff create modules and change behaviour themselves, with no development spend or release wait.
- Lower cost to run: a single NGO runs on App Engine mostly inside the free tier, paying little or nothing each month.
- One maintained product replaces bespoke code. New NGO needs are met by modules or scripts that other NGOs can share.
- Data ownership: an NGO can run its own installation in its own Google Cloud project, so it holds its data. NGOs that do not want to manage hosting use the shared installation instead. Either way, an NGO can export everything at any time and move between the two.
- Accounts and receipts stay trustworthy, because scripts and configuration cannot break the core money rules.

## 3. What Are We Solving?

**Hypotheses / Assumptions:**

- Most NGO operational needs reduce to the same building blocks: record types, fields, relationships, forms, list and detail pages, status workflows with approvals, rules, scheduled and event-triggered automations, notification and document templates, numbering sequences, reports, and role-based permissions.
- A module is a named bundle of those building blocks with its own menu, roles, and starter data. Every existing feature ships as a module built on them: members and identity numbers, donors and donations including recurring, expenses, earnings, invoices, accounts and transfers, projects (goals, milestones, beneficiaries, team, risks), physical assets, book bank, meetings, requests, notifications, correspondence, comments, help content, reports, public site, public forms, and newsletters.
- Most behaviour, including money behaviour, can be handled through configuration. Override scripts are the exception path. They are not the normal way to build.
- A small set of core rules must hold no matter what is configured or scripted; see Known Requirements. Without them, a mistake can misstate the society's signed accounts or expose personal data.
- Configuration and modules are stored as plain definition files. The same files can be authored in the in-product builder or written with Cursor, then imported. This fits fully AI-assisted delivery.

**Known Requirements or Constraints:**

New module creation:

- Administrators create a new module in the builder by naming it and adding its record types, relationships, forms, pages, dashboards, menu entries, workflows, roles, reports, automations, templates, and scripts.
- A module can be enabled, disabled, versioned, exported as a package, and imported into another NGO's installation.
- Starter templates (for example "Small trust", "Membership society", "Programme NGO with field staff") are pre-bundled sets of modules.
- A module that handles money uses the built-in engines through configuration. For example, a new "Fee collection" module issues receipts from a receipt series and posts to accounts through posting rules. It does not keep its own ledger.

What each built-in engine lets NGOs configure:

- Accounting and statutory books: chart of accounts, funds (restricted and unrestricted), posting rules that say which record and status posts to which accounts, financial-year start, account perimeter, depreciation method and rate per asset class, statement layouts, and approval steps for adjustments.
- Receipts and numbering: series per receipt type, number format and prefix, reset period, templates, and void reasons.
- Payments: provider, accepted methods, fee handling, and matching rules for incoming payments.
- Sign-in: allowed methods (email and password, email one-time code, Google sign-in), password rules, session length, and roles that require two-step verification.
- Data separation between NGOs: not configurable. Both installation types ship in the first delivery. In a one-NGO installation, separation comes from each NGO having its own project and database. In a shared installation hosting several NGOs, the product enforces separation on every record, file, sequence, scheduled job, report, script run, and audit event. NGO scope always comes from the signed-in identity.

Override scripts:

- Admins with the script-author permission can attach scripts at defined points: calculated fields, validation, before-save and after-save, workflow transition checks and actions, custom buttons, scheduled jobs, report data shaping, and incoming-payment matching.
- Scripts run in an isolated sandbox with time and memory limits. They have no file access. Network access is limited to connectors the administrator has approved.
- Scripts act with the permissions of the person or the declared service role they run as. They read and write data only through the same rules as the screens.
- Every script has a draft, a test run against sample data, a published version, an earlier version to roll back to, a run log, and a switch to disable it.
- The script-author permission is enough to publish any script, including scripts that touch finance modules. No second approval is needed. The core rules below still apply to every script.
- In a shared installation, a script runs only within its own NGO's data. It cannot change the shared engines or the core rules.

Core rules that neither configuration nor scripts can break:

- Every accounting entry balances: debits equal credits.
- A closed period or year cannot change except through a reopen with a recorded reason.
- An issued receipt number is never reused or altered. A void keeps the number, and a replacement gets a new linked number.
- An account balance changes only through a recorded transaction.
- Permission checks and the audit trail always apply.
- One NGO's data is never visible to another.

Running cost and footprint:

- The target is a single NGO's own installation on Google App Engine standard environment, running mostly within the free tier, on its smallest instance class. That class has about 384 MB of memory, so the server must run comfortably below that.
- The server scales down to zero when idle. Short cold starts are acceptable.
- There is no always-on cache, queue, or paid messaging service. Scheduled work such as recurring donations, reminders, and reports runs from App Engine's built-in scheduler and the database.
- The script sandbox must fit inside the same memory budget.
- Static screens are served from free static hosting.
- Pages stay usable on low-end phones and slow connections. Field staff can capture data offline and sync it later.
- Database: a free hosted PostgreSQL tier such as Neon or Supabase, because App Engine's free tier includes no relational database. The product uses standard PostgreSQL only, so an NGO that outgrows the free cap of about 0.5 GB can move to Google's managed PostgreSQL without rework.

Data location:

- Default to India for every installation. App Engine runs in Google's Mumbai region. The free hosted PostgreSQL uses a Mumbai region where the provider offers one; Supabase does. Files go to Cloud Storage in Mumbai.
- Cloud Storage's free allowance applies only to certain US regions. Keeping files in India adds a small storage charge, typically a few rupees a month for a small NGO.
- The region is chosen at setup and recorded on the installation. An NGO may choose a US region to stay fully free, after it accepts the data-location notice.
- The shared installation runs in India on a paid database.

Cheapest-first providers, all optional and replaceable:

- Online giving, zero-fee default: a UPI QR code and payment link that pay straight into the NGO's own UPI ID. The donation stays pending until it is matched to the bank statement or confirmed by a finance operator.
- Online giving, automatic confirmation: Razorpay or Cashfree, which have no setup or annual fee and charge per transaction. These are optional for NGOs that want instant receipts.
- Email: plain mail sending through the NGO's own Gmail or Google Workspace account. Google for Nonprofits offers Workspace free to eligible NGOs. Brevo's free daily allowance is the fallback.
- App and browser notifications: browser push notifications or Firebase Cloud Messaging, both free, replacing the paid push provider in the current system.
- WhatsApp: free "share to WhatsApp" links in the first delivery, sent by staff by hand. The paid WhatsApp business messaging service comes later.
- SMS: deferred. In India it needs telecom template registration and costs money per message.

Languages:

- The first delivery ships in English and Hindi.
- Every label, menu, message, and document template comes from configurable language packs. An NGO can add Bengali, Marathi, Tamil, Telugu, Kannada, Gujarati, or any other language without code.
- Indian scripts render with the fonts already on the device, because no web fonts are loaded.

Carried over from earlier decisions:

- Configuration safety: every configuration item has a draft, a published version, and an earlier version to roll back to. Publishing never alters historical records.
- Statutory books: all first-delivery rules from the earlier brief carry over. These cover the 1 April to 31 March year, the paid-date rule, the account perimeter, frozen openings, monthly bank agreement, completeness, adjusted trial balance, signed Income and Expenditure and Balance Sheet statements, depreciation, receipt numbering with void and replacement, the handover pack, the ledger-name export, and read-only auditor access. Tax-credit receipts and FCRA books stay deferred.
- Data ownership: an NGO exports all its records, files, and configuration in open formats at any time. Consent is recorded for members, donors, and beneficiaries, in line with India's Digital Personal Data Protection Act, 2023.
- No external web assets: the product loads no fonts, images, scripts, or styles from the public internet.

**First-delivery new capabilities**:

- Online giving: donation and campaign pages, UPI QR code and payment link by default, an optional payment gateway, and automatic receipting from the receipt engine.
- Volunteer management: sign-up, skills, availability, shift scheduling, hours logged, and certificates.
- Compliance calendar: registration renewals (12A, 80G, FCRA, society or trust filings), document expiry, and reminders.

**Later new capabilities**, delivered as modules:

- Donor relationship management (pledges, segments, thank-you and lapsed-donor journeys, duplicate detection).
- Restricted fund tracking.
- Grant management.
- Beneficiary case management.
- Impact measurement and public impact report.
- Events.
- Membership fees and renewals.
- In-kind donations and inventory.
- Governance (resolutions, annual general meeting).
- Bulk email.
- WhatsApp and SMS messaging.
- Outbound event feed for integrations.

**Non-Goals / Scope Exclusions:**

- Override scripts that skip the core rules, permissions, or audit trail.
- Data migration from the current system in the first delivery. Data will be transformed and migrated later.
- Filing with regulators or tax portals, e-signing Form 10B/10BB, tax-credit receipts, and FCRA books in the first delivery.
- Paid SMS and WhatsApp business messaging in the first delivery.
- A native mobile app in the first delivery. A mobile web app that works offline covers field use.
- Payroll and human-resources management.
- Running the current coded system in parallel after cutover.

## 4. Discovery Inputs

**SME Interviews Conducted:** None.

**User Pain Points / Voice of Customer:** No interviews or usage data were supplied. Stated or carried-over pain points:

- Every change, including a new module, needs coding and a redeployment.
- Nonprofits do not want to invest much in web software, in build cost or running cost.
- Some behaviour cannot be predicted in advance, so admins need an escape hatch beyond configuration.
- The auditor should receive a pack and a ledger-name export, not reconstruct books from bank statements.
- NGOs worry about who holds their data.

**Competitive or Internal Benchmarking:**

- Internal: the current system covers members and identity numbers, accounts and transfers, donors and donations including recurring, expenses, earnings, invoices, projects (goals, milestones, beneficiaries, team, risks), physical assets, book bank, meetings, requests with approvals, notifications, correspondence, comments, reports, help portal, quick-access home screen, admin console, shared lookup lists, custom forms limited to a fixed set of record types, document storage, scheduled jobs, and the public site (content, forms, newsletter). It has no general ledger, no configurable pages or record types or modules, no form versioning, and no scripting. Its outside services include a managed sign-in provider, a cache, a queue, a paid push provider, and Google mail, calendar, and file storage.
- External: CiviCRM, Salesforce Nonprofit Cloud, Bloomerang, DonorPerfect, Zoho Creator, and other low-code tools offer similar builders and scripting. They are either costly per user or weak on Indian statutory accounts and receipts. Near-zero running cost on the NGO's own cloud project, plus India-ready books, is the intended difference.

## 5. Experience Direction

**Early Prototype Flow (Optional):** Unknown. No prototype was provided. A suggested flow:

1. The NGO deploys its own installation to its Google Cloud project from a guided setup and picks a starter template.
2. The administrator adjusts modules or creates new ones in the builder, previews them, and publishes.
3. Where configuration falls short, a script author adds a tested, sandboxed override script.
4. Staff, volunteers, and field workers use the pages on desktop or phone, including offline.
5. Donors give through UPI.
6. Finance runs daily money and the statutory year close.
7. The auditor downloads the pack.



**MVP Success Criteria:**

- Parity: every capability in the current system exists as a module in the new product. Migrating the old data is a later step.
- New-module proof: a trained non-developer administrator creates a new module with two related record types, forms, list and detail pages, a two-step approval workflow, a notification, and a report in under one working day, with no code release.
- Script proof: a script author adds a validation script and a scheduled script, tests them against sample data, publishes, and rolls back. A script that tries to post an unbalanced entry, reuse a receipt number, or change a closed year is rejected.
- Versioning: publishing a changed form, workflow, module, or script never alters historical records.
- Cost: an NGO with up to about 500 members and a few thousand transactions a year runs its own installation at no monthly cost. App Engine stays within its free instance and data-transfer allowance, and the database stays within the free hosted PostgreSQL tier.
- Shared installation: automated tests show that no NGO can see or change another NGO's records, configuration, scripts, files, sequences, jobs, or reports.
- Portability: an NGO moves from the shared installation to its own installation, or back, by exporting and importing, without losing data.
- Footprint: the server stays well under the smallest instance's memory, about 384 MB, with scripts running. Common pages load in under 3 seconds on a low-end phone over a slow mobile connection.
- Online giving works with zero transaction fees through UPI QR code and payment link, and receipts are numbered by the receipt engine.
- Volunteer management and the compliance calendar ship as modules, with no capability-specific engine code.
- English and Hindi are complete, and an administrator adds a third language pack without code.
- Statutory books: all MVP criteria from the earlier brief are met.

**Data or API Requirements (Early Signals):**

- Definition store: versioned definitions for modules, record types, fields, relationships, forms, pages, menus, workflows, rules, automations, scripts, templates, sequences, lookup lists, reports, roles, and language packs. Definitions use a documented, validated file format so they can be authored in the builder or with Cursor.
- Generic record store with search, filtering, indexing of configured fields, attachments, comments, and a full change history.
- Script sandbox: a lightweight isolated script runtime with time and memory limits, approved connectors only, and run logging.
- Built-in engines: accounting and statutory books, receipts and numbering, depreciation, account balances and transfers, payments, sign-in and permissions, file storage, scheduling, and document generation.
- Hosting: App Engine standard environment, a free hosted PostgreSQL tier, App Engine's built-in scheduler for timed work, Google Cloud Storage for files within the free allowance, and free static hosting for screens. The same build serves both installation types.
- Providers: UPI payment links, optional Razorpay or Cashfree, mail through Gmail or Workspace or Brevo, and browser push notifications or Firebase Cloud Messaging.
- Import tooling: open spreadsheet and JSON import, so the later transformation of current-system data has a target.

**AI Opportunities and Areas of Delight:**

- Building with AI: definitions and scripts are plain files, so the product team and NGOs can generate modules, forms, workflows, and scripts with Cursor, review them, and import them. This adds no running cost.
- In-product AI stays optional and off by default, because of running cost. Candidates: a configuration assistant, bill and receipt reading for expense claims, duplicate detection for donors and beneficiaries, and plain-language impact summaries.
- Bank agreement, completeness, openings, and year close stay manual, as in the earlier brief.

## 6. Team Enablement Prep

**Key Questions for the Team:**

Resolved:

- The earlier statutory-audit brief is absorbed as a module.
- No-code depth: administrators create new modules and everything inside them. Override scripts cover what configuration cannot.
- Engines are configurable; the core rules listed in Section 3 are protected.
- Cost target: a single NGO's own installation on App Engine, mostly within the free tier.
- First-delivery new capabilities: online giving, volunteer management, and compliance calendar.
- Providers: cheapest-first, as listed in Section 3.
- Languages: English and Hindi first. Other languages come as configurable packs.
- Migration: data is transformed and migrated later, outside the first delivery.
- Delivery method: implementation is fully AI-assisted in Cursor.
- Database: a free hosted PostgreSQL tier such as Neon or Supabase, using standard PostgreSQL only.
- Installation types: both the one-NGO installation and the shared multi-NGO installation ship in the first delivery.
- Script approval: the script-author permission alone publishes any script.

- Shared installation cost: NGOs on the shared installation are charged, to cover its running costs. The pricing model and amount are still to be set.

Still open:

- Data location: whether data kept outside India, or with a database provider outside Google Cloud, is acceptable to NGOs and to legal counsel. Not yet known. Until it is settled, the India-first default under Known Requirements applies.
- Pricing for NGOs on the shared installation: flat monthly fee, tiers by number of members or records, or cost recovery.

**Target Date:** Unknown. No date has been set. Implementation will be fully AI-assisted in Cursor.

### Assumptions, Gaps, and Risks

| Item | Rationale | Impact if wrong | What to verify |
| --- | --- | --- | --- |
| All existing features rebuilt as modules | Product goal: no coding for future change. | Some current behaviour, such as recurring donations, wallet top-up before reimbursement, or the transfer matrix, may need scripts or engine features. | Map every current capability to building blocks, engine configuration, or a script before the build starts. |
| Override scripts | Product decision: admins can modify behaviour with scripts. | Scripts can slow the server, break data, or become unmaintainable code by another name. | Confirm hook points, sandbox limits, and connector approval. Keep the core rules outside script reach. |
| No second approval for finance scripts | Product decision. | A single script author can publish a script that misroutes postings or mismatches payments, without anyone else seeing it first. The core rules stop broken ledgers, not wrong-but-balanced entries. | Make every finance-script publish visible in the change history and notify the treasurer. Revisit approval if errors appear. |
| Core rules beyond script reach | Protects signed accounts, receipts, and personal data. | If scripts could bypass them, an NGO could misstate statements or reuse receipt numbers. | Confirm the six rules with a chartered accountant. |
| Free hosted PostgreSQL tier | Product decision. App Engine's free tier has no database, and Google's managed PostgreSQL costs about USD 7 to 10 a month. | Free tiers cap storage at about 0.5 GB, may pause when idle (slower first request), can change their terms, and sit outside Google Cloud. A shared installation hosting several NGOs will outgrow a free tier quickly. | Check each provider's current limits and terms. Keep documents in Cloud Storage, not the database, to save space. Use standard PostgreSQL only, so moving to a paid tier needs no rework. Plan a paid database for the shared installation. |
| About 384 MB memory on the smallest free instance | The free allowance applies to the smallest instance class. | A generic engine plus a script sandbox may exceed memory, forcing a paid instance size. | Load-test the server and sandbox on the smallest instance before committing. |
| Scale to zero and the built-in scheduler | Avoids always-on cost. | Cold starts slow the first page. Long jobs, such as large reports, may hit request time limits. | Measure cold start. Split long jobs into short scheduled steps. |
| UPI QR code and payment link as the default | Zero fee. | Without automatic confirmation, finance staff match payments by hand and receipts are delayed. | Confirm NGOs accept manual or statement-based matching, with a gateway as an option. |
| Gmail or Workspace mail | Free for most NGOs. | Daily sending limits block bulk mail. | Confirm volumes. Use Brevo or another relay for bulk mail later. |
| India-first data location | Not yet decided. Some Google free allowances apply only to certain US regions. | If counsel requires India, a US setup would need moving. If counsel allows other regions, the India default adds a small cost NGOs could avoid. | Ask counsel about the Digital Personal Data Protection Act cross-border rules and any funder or FCRA expectations. Confirm the database provider offers a Mumbai region on its free tier. |
| Charging NGOs on the shared installation | Product decision. | Charges set too high push NGOs to self-host or leave. Charges set too low leave the shared installation running at a loss. | Model running cost per NGO, then pick a pricing model and set the amounts. |
| Both installation types in the first delivery | Product decision. | The shared installation needs separation by NGO everywhere, which adds build and test effort. A missed boundary exposes another NGO's personal or financial data. | Build NGO scope into the engines from the start and test separation automatically on every release. |
| One-NGO installation setup | Product decision: self-hosted, single NGO. | Each NGO needs a Google Cloud account with a billing card on file, even at zero spend, plus a database account. That can be a setup barrier. | Provide a guided setup and a support path. Offer the shared installation to NGOs that cannot manage this. |
| English and Hindi first | Widest reach in India. | NGOs in other states may need their language at launch. | Confirm pilot NGOs' languages. Language packs make additions cheap. |
| Migration deferred | Product decision. | The new data model may make the later migration harder. | The data migrator (Administration › Data › Migration) loads CSV exports of the current system onto record types, keeps each old id against the record it became, and sets opening balances and receipt numbering at cutover. What remains is exporting the current system's tables and building the record types they map to. Files are not migrated yet. |
| Fully AI-assisted build with no date | Product decision. | Without milestones, scope and quality drift. | Set phase gates: engines, builder, existing modules, new modules, statutory books. Each gate has acceptance tests. |
| Product differentiation | Inferred comparison with commercial tools. | Positioning may not hold. | Do a short competitive review covering price and Indian compliance support. |
