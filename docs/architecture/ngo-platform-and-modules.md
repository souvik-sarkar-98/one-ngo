# Platform and modules

Status: as implemented, 2026-10-25. Code lives in `ngo-platform/`. This records why `platform/` and `modules/` are separate folders, where their contents are stored, and what changes if `platform/` is placed under `modules/`.

## The short version

Both folders are packages of JSON definitions. They use the same manifest and the same loader. They are separate because the product treats them with opposite rules.

`platform/` is what every organisation has. The deploy step (`npm run deploy:prepare`, section 4.4 of `ngo-management-platform.md`) publishes it before a version starts, and an administrator cannot turn it off. Today it is the person profile.

`modules/` is what an organisation chooses. The builder lists each folder, and an administrator can enable or disable it. Today the only package is Donations.

The JSON files on disk are the copy that ships with the product. Once the deploy step has published them, the running app reads and writes the database.

## Why they are not one folder

A single catalogue with a flag would force every reader to remember which package is special. Two folders make the rule visible.

| Rule | `platform/` | `modules/<key>/` |
| --- | --- | --- |
| Who has it | Every organisation, from the first start | Only organisations that enable it |
| Builder catalogue | Absent. No Enable or Disable | Listed. Enable, disable, and update |
| When it is published | The deploy step, before profiles are filled in | The deploy step publishes the packages in `SHIPPED_MODULES`; enable copies one onto an organisation |
| Upgrade | The deploy step reapplies each organisation's changes onto the new base | Only organisations that have the module on, through the module update |
| Setup data | None. Shape only | Roles, ledger accounts, and receipt series, installed when the module is enabled |
| What depends on it | Sign-in, My profile, the directory, and person fields assume `person` exists | Nothing in the product assumes Donations is on |

The manifest in `platform/module.json` says the same thing: these definitions are published to the base layer by the deploy step, and they are not a module, so they cannot be turned off.

## What each folder holds

`platform/` (manifest key `platform`, version `0.1.0`):

| File | Kind | What it describes |
| --- | --- | --- |
| `person.recordType.json` | Record type | One profile per member, linked to the account by `userId`. Name and email stay on the account. |
| `people.listView.json` | List view | How the People screen is laid out. |

`modules/donations/` (manifest key `donations`, version `0.2.1`):

Donor and donation record types, the donation workflow, thank-you and reminder templates, a posting rule and a receipt rule, a thank-you automation, list views, the Fundraising group, and the actions Send reminder, Pay now, and Print receipt. Enabling it also creates the Finance and Viewer roles, the bank, cash, and donation-income accounts, and the donation receipt series.

A package is a folder with `module.json` plus one file per definition. The file name ends with `.<kind>.json`. The loader validates the manifest and every file against the schemas in `schemas/`, then installs definitions in a fixed order so a list view is not published before its record type.

## Files and the database

The files are the shipped source. They are not what screens read on each request, and builder edits do not write back to them.

The deploy step loads `platform/` and writes each definition into the `definition` table with no organisation (`tenant_id` is null) and `module_key` `platform`. That row is the shared base. If the file has not changed, the checksum matches and no new version is stored. A module package is written the same way when it is published, tagged with its own key, such as `donations`. Process start only compares the checksums of the files with the published base rows and refuses to start when they differ.

An organisation then sees definitions in three layers:

| Store | What it holds |
| --- | --- |
| `definition` with `tenant_id` null | The product base. Shared. Published from the files. |
| `definition` with the organisation's id | That organisation's draft or published copy, including a shipped definition after a local change. |
| `extension_patch` | The difference the organisation made to a shipped definition. Re-applied when the product base changes. |
| `tenant_module` | Which optional modules are on, and at which version. Platform is not a row here. |
| `record` | The people, donors, and donations themselves. The JSON files only describe their shape. |

For platform definitions an organisation has not changed, the runtime reads the shared base. A published copy for that organisation wins when one exists. Optional module definitions appear for an organisation only after enable copies the base onto that organisation.

## Enable, disable, and upgrade

Enable, for a folder under `modules/`, publishes the package to the base if needed, creates any setup rows that are missing, records the organisation in `tenant_module`, and materialises each definition with that organisation's patch. Disable retires those organisation copies and marks the module off. Records, setup data, and patches stay, so turning the module on again brings them back. Disable is refused while another enabled module depends on it, or while the organisation's own definitions still refer to it.

Platform never takes that path. There is no `tenant_module` row, so disable answers that the module is not turned on. The deploy step then calls the platform resync: every organisation whose published platform definition is behind the new base has its patch re-applied. An organisation whose patch no longer fits, or that has an open draft, keeps its current version, and the deploy step logs the key.

A local change to a shipped definition is an extension patch. The builder can patch a platform definition without an enable step. It refuses a patch to a module definition until that module is turned on.

## If `platform/` is moved under `modules/`

**Move the folder and leave the code.** The deploy step and process start both read `platform/module.json` from the repository root. After the move that file is gone, so the deploy step throws before it fills in missing profiles, and the server does not start. The copy under `modules/platform/` is not published unless it is listed in `SHIPPED_MODULES`. Rows already in the database stay; this version does not come up to use them.

**Move the folder and point the deploy step and start-up check at `modules/platform/`.** Boot still works, because profiles, the shared base, and the platform resync follow the manifest key `platform`, not the folder. The builder lists every directory under `modules/`, so Platform appears beside Donations as off, with Enable. Enabling copies `person` and `people` onto that organisation. Disabling then succeeds and retires those copies. The shared base is still published for every organisation, so People keeps working while the screen says the module is off. Upgrades also split: the deploy step still reapplies the new Person definition, while the module screen tracks a separate installed version and can still say an update is available after the definitions have already moved.

Leave `platform/` at the repository root.

## Where this is implemented

| Rule | Where |
| --- | --- |
| Folders | `ngo-platform/platform/`, `ngo-platform/modules/` |
| Publish and platform resync (deploy step) | `ngo-platform/src/deployment.ts`, run by `ngo-platform/src/deploy.ts` |
| Start-up check that the deploy step ran | `assertDeploymentPrepared()` in `ngo-platform/src/platform.ts` (`PLATFORM_DIR`, `MODULES_DIR`) |
| Load and publish a package | `ngo-platform/src/metadata/package-loader.ts` |
| Base rows, patches, enable, disable, resync | `ngo-platform/src/metadata/definition-service.ts` (`PLATFORM_MODULE`) |
| Which definitions an organisation reads | `effective()` in the same file: the organisation's published rows, plus platform base rows it has not replaced |
| Module catalogue | `ngo-platform/src/engines/builder/builder-support.ts` (`shipped()` reads only `modules/`) |
| Member picker | `packages/platform/src/application/identity/profile-service.ts` lists active members. An account has no person record. |
| Tables | `ngo-platform/migrations/001_core.sql` (`definition`, `extension_patch`, `tenant_module`, `record`) |
| Disable is refused for a platform that was never enabled | `ngo-platform/test/people-profiles.test.ts` |
