# Importing passes from a sheet

Passes → **Import** creates and updates passes from a spreadsheet. Roles: org admin or pass operator
(`passes:operate`); a read-only member sees imports but cannot start, commit or download results. API:
[`docs/api.md`](api.md#import-passes). Limits and retention: [`docs/operations.md`](operations.md#pass-imports).

## The file

- `.csv`, `.tsv` or `.txt`, UTF-8 (`;` and tab separators are detected). Not `.xlsx`: in Excel use
  Save As, CSV UTF-8.
- Up to 2,000 rows, 2,000,000 bytes, 100 columns, 2,000 characters a cell. One header row; headers are
  unique and not empty.
- A blank cell leaves the field as it is. A file never clears a field.

## Steps

1. **Source.** Pick a released template. Drop a file, paste rows, or paste a sheet link.
2. **Match columns.** Holder email and External ID are pinned first; each template input takes a column.
   Columns named like a field are mapped for you. **Find passes by** External ID, Email or Don't match
   (always create). **Keep values edited in the admin** protects fields someone changed by hand; off, the
   file overwrites them. **Save for this template** makes the next upload of the same columns skip this
   step.
3. **Check.** A dry run: nothing is created. It shows `120 to create · 40 to update · 12 unchanged ·
   3 errors`, up to 20 previews and the first 100 problems. **Download rows with errors** gives your file
   back with a Problem column; fix it in your sheet and upload again.
4. **Commit.** **Email new holders** is off by default. An org can email 500 passes a day and a holder 3 an
   hour. The first rows in file order get mail; the rest are created without it and listed as Not
   emailed, and **Email the rest** sends them later. Rows with errors are skipped only if you tick it.
5. **Progress.** "120 of 160". You can leave the page.
6. **Results.** Counts, failed rows, **Download results** (row, result, pass id, links), **Email the rest**,
   **Remove created passes**.

## What matches

A pass matches by External ID (or email) within the org and mode. Two live passes with one key, a pass of
another template, or a pass synced by a connection is a row error. Removed passes never match. An update
never changes a holder's email (a warning says so).

## Problems you will see

Messages are one sentence with the row, for example "Row 14: Email is not valid." Whole-file refusals:
empty, too large, more than 2,000 rows, not a CSV, not UTF-8, missing or repeated header, more than 100
columns. A saved mapping that names a column the file lacks opens the mapping step again.

## Sheet link

In Google Sheets: **File › Share › Publish to web**, choose the sheet and **Comma-separated values (.csv)**.
Use the `https://docs.google.com/spreadsheets/d/e/<id>/pub?output=csv` link. It can answer with a redirect to a
`*.googleusercontent.com` export host; PassBook follows up to three redirects, https only, public hosts
only, each hop checked. The export link a browser's download button shows (`doc-…-sheets.googleusercontent.com`)
is temporary and fails: do not use it. A published link is a secret: only its host is stored, and it
is never logged. (Checked against Google's published-sheet behaviour, November 2026; re-check the hop if a
link stops working.)

## Remove created passes

Removes only the passes this import created. A pass someone edited or scanned since is kept and counted. It
runs 50 at a time through the normal pass removal under your session, is audited, and can be repeated.
Removal can be restored pass by pass.

## Keep a sheet in sync

On a link import, in Live mode, an org admin (`integrations:manage`) sees **Keep this sheet in sync**. It opens
the new connection form with the **CSV sheet link** connector, the link (only if this tab started the
import), the ID column, the template and the mapping filled in. The connection reads the sheet every 15
minutes, up to 2,000 rows; rows without an ID, or with a repeated one, are skipped. Rows that leave the
sheet follow the connection's **On missing** setting.

## Test mode

Imports belong to the mode they start in. Test imports make test passes and their mail goes to the test inbox.
Keep in sync is not offered in Test.
