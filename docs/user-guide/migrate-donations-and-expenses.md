# Moving donations and expenses from your old system

This guide shows you how to bring donations and expense claims from your old system into OneNGO. It is written for the person doing the migration. Read the whole guide before you start, and work through the steps in order.

## What the migration does

- Each donation and each expense claim becomes a record in OneNGO, with its own new number (for example `DON/2026-27/00001` or `EXP/2026-27/00001`).
- A **paid** donation or **paid** expense claim is posted to the books at the date it was paid. Donations credit *Donations received*. Expenses debit the matching expense account (Administration, Programme, Travel or Other).
- Unpaid items (raised donations, and claims that are draft, submitted, approved or not approved) are loaded as records only. They do not post.
- Your old receipt numbers are **not** re-issued. OneNGO does not print new receipts for migrated donations.
- Your old system's numbers are not kept as the record number. Keep the old number in a field you can search, such as *Notes* (see the mapping tables below).
- Only the **current financial year** posts to the books. Older records must be handled through the opening balances (see *Step 6: Books*).

## Before you start

Check each item below. If one is missing, the migration will stop or refuse rows.

| You need | Why |
| --- | --- |
| The **Donations** module and the **Expenses** module turned on | They provide the donation and expense records, their statuses and their posting rules. |
| The **current financial year** open, starting on the first day of that year (for example 1 April 2026) | A paid item dated in a year that is not open is refused. |
| The bank account (`BANK`), cash account (`CASH`), donation income account (`DONATION_INCOME`), expense accounts and the opening funds account (`OPENING_FUNDS`) in your chart | The posting rules and the opening balances use these codes. |
| The migration permissions: `data:migrate`, `data:migrate:books`, `data:migrate:state`, and `record:donation:import` and `record:expenseClaim:import` | Your administrator gives these. Without `data:migrate:books` you cannot enter opening balances. Without `data:migrate:state` you cannot set Paid, Approved and other statuses. |
| Your old data exported as CSV files, one file per table | The migration reads CSV only. |
| The bills and receipts for expenses, if you want them on the records | Optional. Upload them in the migration's Attachments section. |
| A test run on a copy of the data, if you can | Check is safe to repeat. Run is not: once it finishes, the migration is read-only. |

### Decide which rows to migrate

- **Paid donations and paid expenses from the current financial year:** migrate these. They post to the books.
- **Raised donations and open expense claims from any year:** migrate these if you want to keep them. They do not post.
- **Paid donations and paid expenses from earlier years:** do not put them in the migration. They are refused, because their year is closed. Their totals belong in the opening balances, which you enter in *Step 6: Books*.

## Step 1: Prepare the CSV files

Each file needs **one header row** with the column names. Save each table as its own CSV file. Use the same date format throughout.

### Donations file (for example `donations.csv`)

```csv
Donation No,Donor Name,Donor Email,Amount,Mode,Paid On,Reference,Receipt No,Status
D-1001,Asha Rao,asha@example.org,1000,UPI,15/04/2026,UPI-88231,R-2044,Paid
D-1002,Ravi Kumar,,500,Cash,16/04/2026,,R-2045,Paid
D-1003,Meena Shah,,700,,,,,Raised
```

### Expense claims file (for example `expenses.csv`)

```csv
Claim No,Purpose,Category,Amount,Spent On,Status,Paid From,Paid On,Reference,Notes
E-201,Printing of appeal letters,Programme,2400,20/05/2026,Paid,BANK,22/05/2026,NEFT-7781,
E-202,Auto fare to district office,Travel,850,03/06/2026,Paid,CASH,03/06/2026,,
E-203,Stationery,Admin,380,10/06/2026,Submitted,,,,
E-204,Hotel stay,Travel,4200,12/06/2026,Not approved,,,,Outside policy
```

### Rules for the values

- **Dates:** `dd/mm/yyyy` (15/04/2026) or `yyyy-mm-dd` (2026-04-15). Any other format is refused.
- **Amounts:** plain numbers in rupees, such as `1000` or `2400.50`.
- **Choices** (Mode, Category): the migration accepts the value or the label, in any capitals. For example `UPI`, `upi` and `Cash` all work.
- **Paid From:** must be the exact account code `BANK` or `CASH`. If your old system says something else (for example `Main bank`), add a value rule in the Map step (see Step 3).
- **Status:** must match one of the statuses listed in the mapping tables. Anything else is refused.

## Step 2: Create the migration and upload the files

1. Go to **Administration › Data › Migration** (`/admin/migration`).
2. Select **New migration**. Give it a name, for example `Donations and expenses 2026-27`.
3. On the **Files** step, select **Choose CSV files** and add both files. Each file keeps its own columns.

## Step 3: Map each file to its record type

On the **Map** step, put each file in a group. The donations file goes in the **Donation** group, and the expenses file in the **Expense claim** group.

### Donations mapping

| OneNGO field | Column in your file | Notes |
| --- | --- | --- |
| Old id (the record's key) | `Donation No` | Required. Must be unique. |
| Donor name | `Donor Name` | Required. |
| Donor email | `Donor Email` | Optional. |
| Amount | `Amount` | Required. |
| Payment method | `Mode` | Values: UPI, Cash, Bank transfer, Cheque, Online (gateway). Blank for raised donations. |
| Paid on | `Paid On` | Required for paid donations. |
| Payment reference | `Reference` | Required for paid UPI donations. |
| Notes | `Receipt No` | Keeps the old receipt number. OneNGO has no separate receipt-number field for donations. |
| Status | `Status` | Paid → **Paid**. Raised → **Raised**. |

### Expense claims mapping

| OneNGO field | Column in your file | Notes |
| --- | --- | --- |
| Old id (the record's key) | `Claim No` | Required. Must be unique. |
| Purpose | `Purpose` | Required. |
| Category | `Category` | Required. Values: Administration (or Admin), Programme, Travel, Other. |
| Amount | `Amount` | Required. |
| Spent on | `Spent On` | Required. |
| Notes | `Notes` | Fill it for not-approved claims, to say why. |
| Status | `Status` | Draft → **Draft**. Submitted → **Submitted**. Approved → **Approved**. Not approved → **Not approved**. Paid → **Paid**. |
| Paid from | `Paid From` | Required for paid claims. Must be `BANK` or `CASH`. |
| Paid on | `Paid On` | Required for paid claims. |
| Payment reference | `Reference` | Optional. |
| Reason for going below zero | (leave empty, or a column you add) | Only needed if a payment would take the account below zero. See *Problems* below. |

### Value rules (when your file uses other words)

If your file says `Main bank` where OneNGO expects `BANK`, open **Transform rules** on that field and add a rule: **Source value** `Main bank`, **Transform value** `BANK`. Other values stay as they are, so only add rules for the values you need.

### If a value is refused

Check shows the row and the column. Fix the value in the CSV, upload the file again, and check again.

## Step 4: Set the load order

On the **Order** step, put the **donations file above the expenses file**. Files load from top to bottom, and Check follows the same order. If expenses are paid from cash that donations bring in, the donations must load first.

## Step 5: Attach bills (optional)

On the **Files** step, under **Attachments**, upload the bill images or PDFs. Each expense claim's *Bill* field takes the file name as it appears in your upload, such as `scans/E-201.pdf`. Each attachment can be used by one row only. Files must be within the size limit (5 MB for a bill).

## Step 6: Books (opening balances)

On the **Books** step, enter the balances you had at the start of the current financial year. This step is needed whenever a payment could draw on money from earlier years.

- **Cutover date:** the first day of the current financial year, for example `01/04/2026`. Any other date is refused.
- **Opening journal:** one line per account. Debit the bank and cash accounts with their balances, and credit `OPENING_FUNDS` for the total. The debits and credits must be equal, or the books are refused.
- **Receipt numbering:** the next number for each receipt series, for example `donation-receipt` → `2046` if the highest receipt number used so far is `2045`.

The books apply **before** any row loads. That is why a paid expense can be paid from the opening cash.

## Step 7: Check

Select **Check**. Nothing is saved at this step. Check runs every row through the same rules as a normal save, in the load order, and it predicts the journal entries each row will post.

The result shows, for each file: how many rows are ready, how many have problems, how many records will be created and how many updated. Problems show the file, the **row number** and the message. Row 1 is the header, so the first data row is row 2.

Fix the problems in the CSV files, upload them again, and select **Check again** until no problems remain.

### Common problems and fixes

| Message (or part of it) | What to do |
| --- | --- |
| `is not a date` | Use `dd/mm/yyyy` or `yyyy-mm-dd`. |
| `is not one of the choices` | Fix the value, or add a value rule in Transform rules. |
| `is not open` (financial year) | The row is dated in a year that is closed. Take it out of the file and enter its total in the opening balances. |
| `Cash in hand has only N available` (or the same for `Bank account`) | The payment would take the account below zero at that point in the load order. Check the Books step and the order of the files. For a payment that is genuinely allowed, fill *Reason for going below zero* on that row. |
| `The entry this row would post is refused` | The row's journal entry cannot be posted. The message after the colon says why. Usually a missing account (check *Paid From*) or the financial year. |
| `no ledger account for this row` | A paid claim has no *Paid From* account. Fill it with `BANK` or `CASH`. |
| `Enter the UPI transaction reference.` | A paid UPI donation has no *Reference*. Add it to the file. |
| `Records that are Paid cannot be edited.` | The file changes a record that is already paid. Paid records are final. Remove the row from the file. |

Check is safe to repeat as often as you like.

## Step 8: Run

When Check shows no problems, select **Run N rows**. The migration posts the books first, then loads each row in its own transaction. A row that fails is left out and listed; the others still load.

You can leave the page. You will get a notice in your inbox when the run finishes. Automations, mail and receipts stay off during the run, so no thank-you letters or receipts are sent.

If some rows failed, select **Download failed rows** for that file. Correct them in your CSV and load them in a new migration. A finished migration is read-only, so you cannot change its files.

## Step 9: Check the result

Compare the numbers before you tell the team the migration is done.

1. **Counts:** the number of donation and expense records should match the *created* counts in the Run step, plus any rows you knowingly left out.
2. **Money:** open the bank and cash statements. The paid donations and paid claims should appear at their paid dates.
3. **Reports:** the **donation register** and **expense register** for the current year should match your old system's totals for those items.
4. **Receipts:** no new receipts were issued. Open a migrated donation and check that *Notes* shows its old receipt number.

If a total does not match, do not change records by hand. Note the difference and talk to your administrator, so the cause can be found first.

## What the migration does not do

- It does not post donation processing fees. The journal uses the full donation amount.
- It does not migrate paid items from earlier financial years as journal entries. Enter their totals as opening balances.
- It does not keep old system numbers as OneNGO record numbers. Keep them in *Notes* or *Payment reference*.
- Migrated claims skip the approval step and the transition checks, such as the bill being attached before submission. Claims you create in OneNGO still need approval in the normal way.

## Permissions summary

| Permission | Needed for |
| --- | --- |
| `data:migrate` | Opening the migration, uploading files and mapping them |
| `data:migrate:books` | Entering and applying the opening balances |
| `data:migrate:state` | Loading any file that has a Status column, such as Paid or Approved |
| `record:donation:import` and `record:expenseClaim:import` | Loading donations and expense claims |
