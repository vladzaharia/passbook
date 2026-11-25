---
id: change-many-passes
title: Change many passes
line: Preview, run, undo
status: ready
ops: broadcasts.getBroadcastsByIdItems, broadcasts.postBroadcastsByIdRetry
---
Set, clear, shift or add to an input on every pass a target names. Preview first: it takes the same target and patch as the run, answers with what would change, and changes nothing. A key needs `messages:write` and `passes:write`, and `passes:read` for the preview samples; without one the answer is `403` [MISSING_SCOPE](/developers/errors/MISSING_SCOPE). A sandbox starts up to 10 change runs in 24 hours, drafts included; past that it is `403 SANDBOX_QUOTA`.

## Pick the passes

Send one of three targets. Two at once is `422`.

| Target | Takes |
| --- | --- |
| `templateIds` | Up to 20 templates, with the filters `onDevice`, `holderState`, `q`, `scan` and `match` |
| `passIds` | Up to 5,000 passes |
| `importId` | The passes of an import that has ended and was not undone |

A run reaches active passes only. Voided, removed and expired passes are never targeted. Count a filter with `count=true` on the passes list:

{{run change-count}}

This guide moves the Harbor Hall passes, so make one first. If you made one in another guide, skip this step: it is already in the target.

```json run=passes.postPasses
{
  "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
  "externalId": "order-8842",
  "holderEmail": "grace@example.com",
  "input": {
    "eventName": "Harbor Night",
    "venueName": "Harbor Hall",
    "venueRegion": "Cupertino, CA",
    "startsAt": "2030-06-01T19:00:00-07:00",
    "endsAt": "2030-06-01T22:00:00-07:00",
    "attendee": "Grace Host",
    "ticketId": "TICKET-8842"
  }
}
```

## Preview

`POST /broadcasts/preview`. `patch` takes one operation per input: `{ "set": value }`, `{ "clear": true }`, `{ "shift": "P1D" }` for dates (an ISO 8601 duration, `-P7D` goes back) and `{ "add": 5 }` for numbers. A bare value is `set`.

```json run=broadcasts.postBroadcastsPreview
{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "target": {
    "templateIds": ["0193a1b2-7c00-7000-8000-0000000000b1"],
    "match": [{ "input": "venueName", "values": ["Harbor Hall"] }]
  },
  "patch": { "venueName": { "set": "Pier 9" } },
  "notify": false
}
```

Answer, trimmed:

```json
{
  "targeted": 1,
  "samples": [
    {
      "title": "Harbor Night",
      "changes": [{ "key": "venueName", "label": "Venue", "from": "Harbor Hall", "to": "Pier 9" }]
    }
  ],
  "unchanged": 0,
  "blocked": [],
  "notified": 0,
  "silent": 1,
  "estimated": true
}
```

- `targeted` is the passes it would reach; `unchanged` already hold the new values.
- `blocked` lists passes it can't change, by code: `NO_VALUE`, `NOT_A_DATE`, `NOT_A_NUMBER`.
- `notified` holders get a message; `silent` passes update without one.
- `estimated: true` means the counts come from the 200 newest passes of a larger target.

Preview doesn't refuse an input the template lacks: `changes` comes back empty. Starting the run does, with `422` [BROADCAST_UNKNOWN_INPUT](/developers/errors/BROADCAST_UNKNOWN_INPUT).

## Run

`POST /broadcasts` with an `Idempotency-Key`: a retry with the same key and body returns the same run. Set `expectCount` to the preview's `targeted`; the body below has 1, which is right on a new sandbox. A change is silent unless you set `notify: true`; `message` (up to 120 characters, `{Label}` reads the pass's new value) is the lock-screen text.

{{run change-run}}

The answer is the run, `201`, in state `scheduled` or `sending`. Keep its `id`; in a shell, `export RUN_ID=<id>`. A Test key reaches templates released in Test, a Live key those released in Live.

## Watch

`GET /broadcasts/{id}` with the run's own `id`.

{{run change-watch}}

`state` goes `scheduled`, `sending`, then `sent`, or `partial`, `failed` or `cancelled`. `counts` has `targeted`, `updated`, `unchanged`, `overBudget` (updated without a message because the pass hit its daily limit) and `failed`. `GET /broadcasts/{id}/items?outcome=failed` lists the passes that failed. A failed or stopped run resumes with `POST /broadcasts/{id}/retry?expectCount=<passes left>`. Stop one after its current chunk with `POST /broadcasts/{id}/stop`: what it changed stays.

## Undo

For 24 hours after a run ends, `POST /broadcasts/{id}/undo` starts a silent run that restores each pass to its earlier value, only where the input still holds what the change set. A pass edited since keeps its edit. Moving passes to the latest design can't be undone.

{{show change-undo}}

The answer names the undo run. `restorable` passes come back, `kept` changed since. Read it with `GET /broadcasts/{id}` on the returned `id`.

```json
{ "id": "0193a1b2-7c00-7000-8000-0000000000e2", "parentId": "0193a1b2-7c00-7000-8000-0000000000e1", "restorable": 1, "kept": 0 }
```

## If it fails

Each code links to its entry, which has the cause and fix.

| Code | When |
| --- | --- |
| `409` [SELECTION_CHANGED](/developers/errors/SELECTION_CHANGED) | The count differs from `expectCount` by more than 2% when the run starts. Under 50 passes any difference refuses. Preview again and send the new count. |
| `422` [MATCH_TOO_BROAD](/developers/errors/MATCH_TOO_BROAD) | A filter or import matches more than 20,000 passes. Add a `match` clause or split by template. |
| `422` [BROADCAST_UNSUPPORTED_FILTER](/developers/errors/BROADCAST_UNSUPPORTED_FILTER) | The target has a key a run doesn't define, such as `status`. List the passes with it, then send `passIds`. |
| `404` [TEMPLATE_NOT_FOUND](/developers/errors/TEMPLATE_NOT_FOUND) | No release in the key's mode and no active passes. |
| `409` [BROADCAST_NOT_UNDOABLE](/developers/errors/BROADCAST_NOT_UNDOABLE) | The run is still sending. Stop it, or wait for `sent`. |
| `409` [BROADCAST_UNDO_EXPIRED](/developers/errors/BROADCAST_UNDO_EXPIRED) | More than 24 hours since it ended. |

## Result

Preview: `targeted` is 1 and the sample shows Harbor Hall to Pier 9. Nothing changed. Read the run until `state` is `sent`, in a sandbox too: `counts.updated` is 1. After the undo, the pass is back at Harbor Hall.
