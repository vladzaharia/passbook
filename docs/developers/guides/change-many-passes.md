---
id: change-many-passes
title: Change many passes
line: Preview, run, undo
status: ready
ops: broadcasts.getBroadcastsByIdItems, broadcasts.postBroadcastsByIdRetry
---
Set, clear, shift or add to an input on every pass a target names. Preview first: it takes the same target and patch as the run, answers with what would change, and changes nothing. A key needs `messages:write` and `passes:write`, and `passes:read` for the preview samples; without one the answer is 403 [MISSING_SCOPE](/developers/errors/MISSING_SCOPE). A sandbox starts up to 10 runs a day; past that it is 403 `SANDBOX_QUOTA`.

## Pick the passes

Send one of three targets. Two at once is 422.

| Target | Takes |
| --- | --- |
| `templateIds` | Up to 20 templates, with the filters `onDevice`, `holderState`, `q`, `scan` and `match` |
| `passIds` | Up to 5,000 passes |
| `importId` | The passes of an import that has ended and was not undone |

A run reaches active passes only. Voided, removed and expired passes are never targeted. Count a filter with `count=true` on the passes list:

{{run change-count}}

## Preview

`patch` takes one operation per input: `{ "set": value }`, `{ "clear": true }`, `{ "shift": "P1D" }` for dates (an ISO 8601 duration, `-P7D` goes back) and `{ "add": 5 }` for numbers. A bare value is `set`.

```json run=broadcasts.postBroadcastsPreview
{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "target": {
    "templateIds": [
      "0193a1b2-7c00-7000-8000-0000000000b1"
    ],
    "match": [
      {
        "input": "venueName",
        "values": [
          "Sample Hall"
        ]
      }
    ]
  },
  "patch": {
    "venueName": {
      "set": "Pier 9"
    }
  },
  "notify": false
}
```

```json
{
  "targeted": 1,
  "onDevice": 0,
  "overBudget": 0,
  "limit": 3,
  "samples": [
    {
      "passId": "0193a1b2-7c00-7000-8000-0000000000c1",
      "title": "Sample Event",
      "changes": [{ "key": "venueName", "label": "Venue", "from": "Sample Hall", "to": "Pier 9" }]
    }
  ],
  "unchanged": 0,
  "blocked": [],
  "notified": 0,
  "silent": 1,
  "estimated": true
}
```

- `targeted` is the passes it would reach. `unchanged` already hold the new values.
- `blocked` lists passes it can't change, by code: `NO_VALUE` (nothing to shift or add to), `NOT_A_DATE`, `NOT_A_NUMBER`.
- `notified` holders get a message; `silent` passes update without one.
- `samples` show up to 20 passes before and after.
- `estimated: true` means the counts come from the 200 newest passes of a larger target.

Preview doesn't refuse an input the template lacks: `changes` comes back empty. Starting the run does, with 422 [BROADCAST_UNKNOWN_INPUT](/developers/errors/BROADCAST_UNKNOWN_INPUT).

## Run

Send the preview's `targeted` as `expectCount`, and an `Idempotency-Key`: a retry with the same key and body returns the same run. A change is silent unless you set `notify: true`; `message` (up to 120 characters, `{Label}` reads the pass's new value) is the lock-screen text.

```json
{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "kind": "change",
  "name": "Move to Pier 9",
  "send": "now",
  "notify": false,
  "target": {
    "templateIds": [
      "0193a1b2-7c00-7000-8000-0000000000b1"
    ],
    "match": [
      {
        "input": "venueName",
        "values": [
          "Sample Hall"
        ]
      }
    ],
    "expectCount": 1
  },
  "patch": {
    "venueName": {
      "set": "Pier 9"
    }
  }
}
```

{{show change-run}}

The answer is the run, `201`, in state `scheduled` or `sending`. A Test key reaches templates released in Test, a Live key those released in Live.

## The 2% drift rule

The server counts again when the run starts. If the count differs from `expectCount` by more than 2%, nothing starts and the answer is 409 [SELECTION_CHANGED](/developers/errors/SELECTION_CHANGED). At `expectCount: 1240` a difference of 24 passes starts, 25 does not. Under 50 passes any difference refuses.

```json
{
  "type": "https://passbook.mobile/developers/errors/SELECTION_CHANGED",
  "title": "Conflict",
  "status": 409,
  "code": "SELECTION_CHANGED",
  "detail": "The selection is now 1270 passes, not 1240. Review it again."
}
```

Preview again and send the new count. Passes by `passIds` are not counted unless you send `expectCount`.

## MATCH_TOO_BROAD

A filter or an import that matches more than 20,000 passes is 422 [MATCH_TOO_BROAD](/developers/errors/MATCH_TOO_BROAD), on preview and on run. Add a clause to `match`, or split the target by template.

## Filters a run can't take

The passes list filters more than a run does. A target key the run does not take is 422 `BROADCAST_UNSUPPORTED_FILTER` on preview and on run, and `issues` names the field (`target.status`), so a run never reaches more passes than you asked for.

- `status`, `holderEmail`, `externalId`, `connectionId`: list the passes with them, then send the ids as `passIds`.
- `templateId`: send `templateIds`.
- `match` clauses with `contains` or `startsWith`: 422. A run matches values or ranges.
- More than 3 `match` clauses: 422 on run.

## Watch

{{show change-watch}}

`state` goes `scheduled`, `sending`, then `sent`, or `partial`, `failed` or `cancelled`. `counts` has `targeted`, `updated`, `unchanged`, `overBudget` (updated without a message because the pass hit its daily limit) and `failed`. `GET /broadcasts/{id}/items?outcome=failed` lists the passes that failed. A failed or stopped run resumes with `POST /broadcasts/{id}/retry?expectCount=<passes left>`.

Stop a run after its current chunk with `POST /broadcasts/{id}/stop`. What it changed stays.

## Undo

For 24 hours after a run ends, `POST /broadcasts/{id}/undo` starts a silent run that restores each pass to its earlier value, only where the input still holds what the change set. A pass edited since keeps its edit. A run that is still sending is 409 [BROADCAST_NOT_UNDOABLE](/developers/errors/BROADCAST_NOT_UNDOABLE): stop it first. After 24 hours it is 409 [BROADCAST_UNDO_EXPIRED](/developers/errors/BROADCAST_UNDO_EXPIRED). Moving passes to the latest design can't be undone.

{{show change-undo}}

```json
{
  "id": "0193a1b2-7c00-7000-8000-0000000000e2",
  "parentId": "0193a1b2-7c00-7000-8000-0000000000e1",
  "restorable": 1240,
  "kept": 0
}
```

`restorable` passes come back, `kept` changed since. Read the undo with `GET /broadcasts/{id}` on the returned `id`.

## Result

Read the preview: `targeted` is the passes the target reaches, and each sample shows the pass's value before and after. Nothing changed. Read the run until state is `sent`, in a sandbox too: `counts.updated` matches the preview's `targeted`, and after an undo each pass is back to its earlier value.
