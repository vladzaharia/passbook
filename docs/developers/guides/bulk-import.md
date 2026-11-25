---
id: bulk-import
title: Bulk import
line: A CSV to passes
status: ready
---
Turn a spreadsheet into passes in three calls: create the import, check it, commit it. Check reports every row that would fail before anything is made. A sandbox makes test previews only.

## Create the import

The file goes in as text. You map its columns in the next step.

{{run bulk-import}}

Keep the answer's `id`. In a shell, `export IMPORT_ID=<id>`. In the console, paste it into the path of the next two steps.

## Check the rows

Map each template field to a column or a constant. A constant ignores its column, so point it at any column; here, `attendee`. Bad rows come back with the reason.

```json run=pass-imports.postPassImportsByIdCheck
{
  "plan": {
    "mapping": {
      "attendee": { "from": "attendee" },
      "ticketId": { "from": "ticket" },
      "eventName": { "from": "attendee", "transform": { "kind": "constant", "options": { "value": "Harbor Night" } } },
      "venueName": { "from": "attendee", "transform": { "kind": "constant", "options": { "value": "Harbor Hall" } } },
      "venueRegion": { "from": "attendee", "transform": { "kind": "constant", "options": { "value": "Cupertino, CA" } } },
      "startsAt": { "from": "attendee", "transform": { "kind": "constant", "options": { "value": "2030-06-01T19:00:00-07:00" } } },
      "endsAt": { "from": "attendee", "transform": { "kind": "constant", "options": { "value": "2030-06-01T22:00:00-07:00" } } }
    },
    "holderEmail": { "from": "email" },
    "externalId": { "from": "ticket" },
    "match": "externalId"
  }
}
```

Send it to `POST /pass-imports/{id}/check`. Check as often as you like: nothing is made until commit. Fix the sheet, or commit with `skipInvalid`.

## Commit

Send it to `POST /pass-imports/{id}/commit`.

```json run=pass-imports.postPassImportsByIdCommit
{ "skipInvalid": true }
```

Commit runs in the background. One import of a template commits at a time: a second commit meanwhile is `409` [IMPORT_BUSY](/developers/errors/IMPORT_BUSY).

## Watch it finish

Read the import until `state` is `done`.

{{run import-status}}

## If it fails

| Code | Cause | Fix |
| --- | --- | --- |
| `404` [IMPORT_NOT_FOUND](/developers/errors/IMPORT_NOT_FOUND) | The id is not an import of this organization. | Use the `id` from the create answer. |
| `409` [IMPORT_BUSY](/developers/errors/IMPORT_BUSY) | Another import of the template is committing. | Wait for it to be `done`, then send again. |

## Result

`state` is `done` and `progress.created` is 5. [List the passes](console:passes.getPasses): add `importId=<id>` to see only these. `GET /pass-imports/{id}/results.csv` lists what each row did, and `errors.csv` the rows that failed.
