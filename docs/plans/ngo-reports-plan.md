# Custom PDF and Excel reports

Status: implemented. Branch `features/custom-reports`, worktree `.data/worktrees/custom-reports`.

A report definition gathers records, totals and optional sandboxed code, then renders that data as a print HTML template (PDF via the browser) and an Excel workbook.

## Locked choices

- PDF is the browser print of a document HTML template. No server PDF library and no headless browser in this change.
- A shape script, and a report that reads the ledger, may be published only by an organisation administrator (`config:script:admin`), the same rule as a finance script.
- 80G and FCRA reports are not built. A coded `ReportProvider` interface is, so a module can register one later.
- Excel uses `exceljs` from `https://registry.npmjs.org/` only.

## Data flow

1. The person fills the report's parameters.
2. Datasets load: a record query (through `RecordService`, so visibility and masking stay as they are), an aggregate, or ledger balances.
3. Calculations are expressions, including `sum`, `avg`, `count`, `formatMoney`, `formatDate` and `inWords`.
4. An optional shape script (`reportShape`, only inside a background job) or a registered provider may replace the data model.
5. The same model fills a document HTML template and an Excel workbook.

## Definition

`report` is a definition kind. It has parameters, datasets, calculations, an optional shape (`script` or `provider`), and `outputs.pdf` / `outputs.excel`.

Document templates are message templates with `kind: "document"`. They keep `{{ expression }}` and add `{{#each path as name}}`, `{{#if expr}}` / `{{else}}` and `{{> partial}}`. `sanitiseDocumentHtml` is the email allow-list plus one `<style>` block limited to page setup, page breaks, repeating table headers and fonts. Images come only from organisation and record file paths.

## Run

`ReportService` checks `report:<key>:run`, builds the model and audits `reports.run`.

- Under 5,000 rows and with no shape script, Excel streams back in the response and the preview returns HTML for the browser print dialog.
- Otherwise a `report` job writes the workbook through `FileService` and notifies the person. PDF is not produced on the server.
- A shape script receives `params` and `datasets`, returns the data model, proposes no effects, and is capped at 2 MB and 3 seconds. It runs only inside that job.

## Screens

- `GET /api/reports`, `POST /api/reports/:key/preview`, `POST /api/reports/:key/run?format=xlsx`.
- A Reports screen, a print view, Builder editing through the schema form, and an A4 preview for document templates.
- A record action step `report` opens a report with the record's id.

The donations module ships `donationSummary`: paid donations in a date range, totals, a document template and an Excel sheet.
