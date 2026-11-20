---
id: bulk-import
title: Bulk import
line: A CSV to passes
status: ready
---
Turn a spreadsheet into passes in three calls: create the import, check it, commit it. Check reports every row that would fail before anything is made. A sandbox makes test previews only.

## Create the import

The file is sent as text. Map its columns in the next step.

```json run=pass-imports.postPassImports
{
  "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
  "source": {
    "kind": "file",
    "name": "guests.csv",
    "csv": "attendee,ticket,email\nAda Example,TICKET-1001,ada@example.com\nGrace Host,TICKET-1002,grace@example.com\nAlan Guest,TICKET-1003,alan@example.com\nEdsger Visitor,TICKET-1004,edsger@example.com\nBarbara Member,TICKET-1005,barbara@example.com"
  }
}
```

Keep the import `id`.

## Check the rows

Map each template field to a column or a constant. Paste the import `id` into the path.

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

Bad rows come back with the reason. Fix the sheet or commit with `skipInvalid`.

## Commit

```json run=pass-imports.postPassImportsByIdCommit
{ "skipInvalid": true }
```

Commit runs in the background. Read the import until `state` is done. One import of a template commits at a time: a second commit meanwhile is `409 IMPORT_BUSY`.

## In code

{{show bulk-import}}

## Act on up to 100 passes at once

Void, email or remove passes by id.

{{run bulk-void}}

## Result

Read the import: `state` is `committing` while it runs and `done` after, with the counts. Then [list the passes](console:passes.getPasses); each has a `downloadUrl` to its test preview. When it is done, `results.csv` and `errors.csv` list what each row did.
