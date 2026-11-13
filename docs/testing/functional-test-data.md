# Functional test data

Loaded into the local database on 2026-11-03 for the functional test plan. Sign-in is `http://localhost:4200/o/<code>/sign-in`. The API is `http://localhost:8080`.

The accounts and sample data are the `riverbank` organisation in `utilities/data/dev-seed.sql`. Every seeded member uses the password on the `-- @password` line of that file. `npm run dev` runs an organisation's SQL block when that organisation is not already in the database. An organisation that is already present is left as it is, including its members and the Ravi Kumar records. Paid-on dates are the date the seed runs.

## Passwords

| Accounts | Password |
| --- | --- |
| Every seeded member | `Password@01` |

`twostep@riverbank.example` has two-step required and no authenticator enrolled.

## Organisations

| Code | Name | Region | Module | Financial year | Members | Donors | Donations |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `riverbank` | Riverbank Trust | asia-south1 | Donations | start month 4; year label from the seed date | 12 | 3 | 9 |
| `harbour` | Harbour Relief | asia-south1 | Donations | start month 4; year label from the seed date | 2 | 0 | 0 |
| `demo` | Demo Foundation | asia-south1 | Donations | April start, label from the seed date | 1 | 0 | 0 |

`demo` and `harbour` get the organisation, the Donations module, and their members. They do not get sample donors or donations. An organisation already in the database is skipped, so records loaded by an older seed stay.

Enabling Donations also created the ledger accounts `BANK` (Bank account), `CASH` (Cash in hand), and `DONATION_INCOME` (Donations received), and the receipt series `donation-receipt` with prefix `RCPT`, reset each financial year.

The operator console was not given operator accounts, grants, or API keys.

## Roles on Riverbank Trust

Finance and Viewer come from the Donations module. The others were added for this plan.

| Key | Label | Permissions | Two-step |
| --- | --- | --- | --- |
| `admin` | Administrator | `*` | No |
| `finance` | Finance | `record:donor:*`, `record:donation:*`, `record:donation:transition:*`, `record:donation:action:*`, `payments:create`, `payments:confirm`, `money:accounts:read`, `people:read` | No |
| `viewer` | Viewer | `record:donor:read`, `record:donation:read`, `people:read` | No |
| `people-admin` | People administrator | `members:manage` | No |
| `roles-admin` | Roles administrator | `admin:roles` | No |
| `config` | Config author | `config:read`, `config:publish` | No |
| `script` | Script author | `config:script:publish` | No |
| `directory` | Directory | `people:read` | No |
| `noaccess` | No access | none | No |
| `privacy` | Privacy | `privacy:consent:record`, `privacy:consent:read`, `privacy:erase` | No |
| `two-step` | Two-step required | `record:donor:read`, `record:donation:read` | Yes |

Harbour Relief has `admin` and the module roles `finance` and `viewer`. Demo Foundation has `admin` and the same module roles.

## Members

Persona names match section 7 of the functional test plan.

| Persona | Organisation | Name | Email | Role |
| --- | --- | --- | --- | --- |
| ADMIN | riverbank | Asha Menon | `asha@riverbank.example` | `admin` |
| FIN | riverbank | Finance Member | `finance@riverbank.example` | `finance` |
| VIEW | riverbank | Viewer Member | `viewer@riverbank.example` | `viewer` |
| PEOPLE-ADMIN | riverbank | People Administrator | `people@riverbank.example` | `people-admin` |
| ROLES-ADMIN | riverbank | Roles Administrator | `roles@riverbank.example` | `roles-admin` |
| CONFIG | riverbank | Config Author | `config@riverbank.example` | `config` |
| SCRIPT | riverbank | Script Author | `script@riverbank.example` | `script` |
| DIR | riverbank | Directory Member | `directory@riverbank.example` | `directory` |
| NOACCESS | riverbank | No Access Member | `noaccess@riverbank.example` | `noaccess` |
| PRIV | riverbank | Privacy Officer | `privacy@riverbank.example` | `privacy` |
| TWOSTEP-REQ | riverbank | Two Step Member | `twostep@riverbank.example` | `two-step` |
| SHARED | riverbank and harbour | Shared Member | `shared@riverbank.example` | `viewer` in both |
| B-ADMIN | harbour | Harbour Admin | `admin@harbour.local` | `admin` |
| — | demo | Demo Admin | `admin@demo.local` | `admin` |

These personas are not loaded: OP-FULL, OP-LOOK, OP-NONE, TWOSTEP-ON, API-VIEW, API-FIN.

## Donors on Riverbank Trust

| Name | Email | Phone | PAN | City | Address | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Ravi Kumar | `ravi@donor.example` | +91 98765 43210 | `ABCDE1234F` | Bengaluru | 12 Lake Road | Functional test plan sample. |
| Meera Iyer | `meera@donor.example` | +91 80 4000 1200 | none | Bengaluru | none | Functional test plan sample. No PAN. |
| `Long Name Donor ` then `N` until the name is 200 characters | none | none | none | Mysuru | none | Functional test plan sample. 200 character name. |

## Donations on Riverbank Trust

Paid on is the date the seed runs. Amounts are rupees.

| Donor | Amount | Fee | State | Method | Reference |
| --- | --- | --- | --- | --- | --- |
| Ravi Kumar | 1000 | 10 | Raised | | |
| Ravi Kumar | 1 | 0 | Raised | | |
| Walk-in donor | 99999999.99 | 0 | Raised | | |
| Ravi Kumar | 500 | 0 | Paid | cash | |
| Ravi Kumar | 750 | 0 | Paid | bank_transfer | `NEFT1001` |
| Ravi Kumar | 250 | 0 | Paid | upi | `UPI123456` |
| Ravi Kumar | 300 | 0 | Paid | cheque | `CHQ42` |
| Ravi Kumar | 1500 | 0 | Paid | online | `GATEWAY9` |
| Ravi Kumar | 200 | 0 | Cancelled | | |

## Not loaded

Prepare these during the run. They are specified in section 7.2 of the functional test plan and are not rows in the database:

- Operator accounts and grants.
- An enrolled authenticator for TWOSTEP-ON.
- API keys for API-VIEW and API-FIN.
- Image, document, and oversized file fixtures.
- CSV fixtures.
- Hindi, Tamil, Telugu, Bengali, Marathi, emoji, right-to-left, and HTML or script text samples.

Onboarding cases still use the Riverbank request in the manual test plan, section 4, with a fresh `requestId`, because the code `riverbank` already exists.
