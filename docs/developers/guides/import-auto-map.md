---
id: import-auto-map
title: Import with auto mapping
line: Map a CSV from the template
status: ready
ops: pass-imports.getPassImportsMappings, pass-imports.putPassImportsMappings
---
Send a CSV and the server maps its columns to the template's fields, checks every row and tells you what it would do. Fix what is wrong, commit, and undo within 24 hours if the file was wrong. For a sheet that needs hand mapping, see [bulk import](/developers/guides/bulk-import).

## Start from the sample file

The template makes its own sample: its field labels as headers, plus Holder email, and one valid row. A file with those headers maps in full.

{{show import-sample}}

## Create the import

`POST /pass-imports` with `mapping: "auto"` maps the headers and checks the file in the same call. Send an `Idempotency-Key` so a retry returns the same import. Row 3 has a bad date on purpose.

```json run=pass-imports.postPassImports
{
  "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
  "source": {
    "kind": "file",
    "name": "guests.csv",
    "csv": "Holder email,Event,Venue,City,Starts,Ends,Attendee,Ticket ID\nada@example.com,Harbor Night,Harbor Hall,\"Cupertino, CA\",2030-06-01T19:00:00-07:00,2030-06-01T22:00:00-07:00,Ada Example,TICKET-1001\ngrace@example.com,Harbor Night,Harbor Hall,\"Cupertino, CA\",TBD,2030-06-01T22:00:00-07:00,Grace Host,TICKET-1002\nalan@example.com,Harbor Night,Harbor Hall,\"Cupertino, CA\",2030-06-01T19:00:00-07:00,2030-06-01T22:00:00-07:00,Alan Guest,TICKET-1003"
  },
  "mapping": "auto"
}
```

Keep the answer's `id`. In a shell, `export IMPORT_ID=<id>`. In the console, paste it into the path of the later steps. The answer, trimmed to the fields that matter:

```json
{
  "state": "ready",
  "counts": { "rows": 3, "create": 2, "update": 0, "unchanged": 0, "errors": 1, "warnings": 0, "emailable": 2 },
  "problems": [
    {
      "row": 3,
      "column": "Starts",
      "field": "startsAt",
      "code": "IMPORT_DATE_UNREADABLE",
      "message": "Starts is not in the right format.",
      "severity": "error",
      "value": "TBD"
    }
  ],
  "mapping": { "missing": [], "unused": [], "columns": 8, "used": 8 }
}
```

- `counts` are by what a row would do: `create`, `update` (a pass with the same External ID), `unchanged`. `errors` rows are counted by `errorsCreate` and `errorsUpdate` for what they would do once fixed.
- `problems` name the spreadsheet row (the header is row 1), the column, the field's label and the cell as written.
- `plan` is the mapping it chose, ready to send back to check.
- `mapping.fields` lists each template field with its `from` column and `confidence`: `exact`, `similar`, `values` (read from the cell values) or `join`.

## When it can't map

State `mapping` and no `plan` mean a required field found no column. `mapping.missing` lists them and `mapping.unused` the columns nothing took. Rename the headers or build the plan yourself, starting from each field's `entry`, and send it to check.

Two date formats can fit one column (`03/04/2030` is March 4 or April 3). That field's `date.choices` names them and its `entry` is null, so rows report `Starts is required`. Name the format in the plan:

```json
"startsAt": { "from": "/Starts", "transform": { "kind": "date", "options": { "input": "mdy", "output": "iso", "keepOffset": true } } }
```

An unknown option in an enum column fails the row with the labels to pick from, for example `Status must be Active or Suspended.`

## Fix a cell

Send the answer's `plan` back to `POST /pass-imports/{id}/check` with the corrected value under the spreadsheet row and the column pointer in `overrides`. The file stays as it is; check runs again with the fix. Up to 200 cells.

```json
"overrides": { "3": { "/Starts": "2030-06-01T19:00:00-07:00" } }
```

{{run import-fix-cells}}

`errors` is now 0 and `create` is 3. Cell fixes are not kept. To reuse the mapping, save it under a name with `PUT /pass-imports/mappings`: the next file with at least 80% of its headers maps itself from it.

## Commit

`POST /pass-imports/{id}/commit` makes the passes in the background. `skipInvalid: true` skips error rows instead of refusing them. Email is off unless you ask: `true` sends at once, and `{ "send": "held" }` holds the mail for `holdMs` (1 to 60 minutes, 5 by default) so an undo cancels it.

```json run=pass-imports.postPassImportsByIdCommit
{
  "skipInvalid": false,
  "email": {
    "send": "held",
    "holdMs": 300000
  }
}
```

One import of a template commits at a time: a second commit meanwhile is 409 [IMPORT_BUSY](/developers/errors/IMPORT_BUSY).

## Watch

`GET /pass-imports/{id}`.

{{run import-status}}

`state` is `committing` until `done`. `progress` counts `created`, `updated`, `unchanged`, `failed` and `skipped`. For each row, read `GET /pass-imports/{id}/rows`: an update lists its `changes` as label, from and to.

## Undo

For 24 hours after the import ends, `POST /pass-imports/{id}/undo` removes the passes it created and puts back the ones it updated. A pass edited or scanned since stays and is listed in `kept` with a code: `IMPORT_PASS_CHANGED`, `IMPORT_PASS_SCANNED` or `IMPORT_PASS_GONE`. Held mail is cancelled; mail already sent is not recalled. While the commit runs the answer is `409` [IMPORT_BUSY](/developers/errors/IMPORT_BUSY). After 24 hours it is `409` [IMPORT_UNDO_EXPIRED](/developers/errors/IMPORT_UNDO_EXPIRED).

{{run import-undo}}

The answer starts the undo, and asking again returns the same one. Read the import until its `undo.state` is `done`. This is the undo of a clean import:

```json
{ "state": "done", "removed": 3, "restored": 0, "keptTotal": 0, "kept": [], "emailsCancelled": 3 }
```

## Result

Read the import: `state` is `done` with `progress.created` at 3. [List the passes](console:passes.getPasses) with `importId=<id>` to see them. `GET /pass-imports/{id}/results.csv` lists what each row did, with each pass's link and test preview. After the undo, `undo.state` is `done` and the passes are voided.
