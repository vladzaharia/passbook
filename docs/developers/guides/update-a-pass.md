---
id: update-a-pass
title: Update a pass
line: Change fields, notify
status: ready
ops: passes.getPassesById
---
Change a field on a pass you made, handle a stale version, and void the pass if the order is cancelled. You need a pass: make one with [issue on purchase](/developers/guides/issue-on-purchase) and set `PASS_ID` to its `id`.

## Read the version

Every change names the `version` you last read. Set `VERSION` to the `version` in the answer.

{{run read-pass}}

## Change a field

`PATCH` takes the fields to change under `input`. Send `If-Match` with the `VERSION` you read: if the pass changed since, the call is refused instead of overwriting it. `notify: true` asks for a push to phones that have the pass.

{{run update-field}}

The answer is the pass with `version` one higher. The `ETag` header carries the same number: use it as the next `VERSION`.

## Guard against a stale write

An `If-Match` that is not the pass's current version is `412` [VERSION_CONFLICT](/developers/errors/VERSION_CONFLICT). This request sends version 0, which no pass has ever had.

{{show stale-write}}

Handle it by reading the pass again, applying your change to what you read, and sending the new `version`. Without `If-Match`, the last write wins.

## Read what changed

{{run pass-activity}}

The activity list is newest first. `pass.updated` carries the new `version`. With `notify`, a `push.queued` entry follows: a sandbox queues the push and never sends it. The pass detail lists every version.

## Void a pass

A voided pass shows as void and scans are refused. The record and its link stay.

{{run void-pass}}

Undo it:

{{run unvoid-pass}}

To end a pass for good, see [pass lifecycle](/developers/guides/pass-lifecycle).

## Result

Read the pass: `subtitle` says Ada Lovelace and `version` is one higher than before. The activity list holds the `pass.updated` entry. Nothing was pushed to a phone; the pass detail and the activity list are the proof.
