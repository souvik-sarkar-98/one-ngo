# Release 1 — download sizes — 2026-10-24

Build: `wt-b45` (branch `b45`, on top of master `e22ac07`), `npm --prefix web run build` (production, named chunks, output hashing, service worker).
Measured by `check-release.mjs` (C4; `--sizes` prints the breakdown) on `web/dist/web/browser`: brotli on every file, 1 kB = 1000 bytes, the same measure `test/web-build.test.ts` uses for the first download.

## Budgets (Architecture §6)

| Bundle | Measured | Budget | Headroom | Files |
| --- | --- | --- | --- | --- |
| Initial download | 89.5 kB | 90 kB | 0.5 kB | 9 (main, 7 chunks, styles) |
| Records chunk | 22.4 kB | 130 kB | 107.6 kB | 2 (`records.routes`, import text) |
| Inbox chunk | 5.2 kB | 60 kB | 54.8 kB | 1 (`inbox.screen`) |
| Builder chunk | 125.4 kB | 180 kB | 54.6 kB | 19 (route file, every Builder screen and editor, Builder-only chunks, Builder text) |

**What an area's chunk counts.** Every file reachable from the area's route entry through static and lazy imports that no other area reaches, plus the English text its route loads. So the Builder figure is all of the Builder together, not just one screen. The old check read Angular's build table, which lists only the 15 largest lazy chunks and has no single "builder" chunk, so it could not find the Builder at all. For records and inbox it measured only the entry chunk; the new measure is never smaller than that.

## Not charged to one area

| What | Size | Notes |
| --- | --- | --- |
| Shell after sign-in | 13.3 kB | `shell.routes` and its imports; loaded once before any destination |
| Lazy chunks shared by several areas | 182.5 kB in 43 files | Largest: Material and the form controls 69.2 kB, the record panel and list core 23.4 kB, the people screen (directory and Administration) 10.3 kB, shared list chunk 8.4 kB |
| Administration | 33.8 kB own | `admin.routes` (not budgeted) |
| Others (own code) | — | sign-in 2.1, reset password 1.2, print receipt 2.2, Home 3.1, Records groups 1.7, More 3.7, Angular's animation engine (loaded lazily, `browser-*.js`) 17.8 kB |

## What a person downloads when first opening an area

Everything the area's entry imports statically, after the first download and the shell. This includes the shared chunks the area needs, which are paid once by whichever area opens first.

| Area | First open | With every lazy screen of the area |
| --- | --- | --- |
| Records (a record list) | 181.8 kB | 186.2 kB |
| Inbox | 143.1 kB | 147.6 kB |
| Builder (catalogue) | 138.6 kB | 281.1 kB |

If the budgets were meant as first-open cost, records and inbox would be over budget, because Material (69 kB) and the record panel (23 kB) come with whichever list opens first. This is listed as an exception for agreement in the validation report.

## Watch

- The initial download has 0.5 kB of headroom. Anything added to the shell, the router setup, `styles.css` or the core text pushes it over, and `test/web-build.test.ts` fails the build tests.
- Six languages are lazy chunks. Only the chosen language's area text is fetched.
