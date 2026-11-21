---
id: update-a-pass
title: Update a pass
line: Change fields, notify
status: ready
ops: passes.getPassesById
---
Change a field on a pass you made, handle a stale version, and end the pass if the order is cancelled. You need a pass: make one with [issue on purchase](/developers/guides/issue-on-purchase) and keep its `id` and `version`.

## Change a field

`PATCH` takes the fields to change under `input`. `notify: true` asks for a push to phones that have the pass.

{{run update-field}}

Paste the pass `id` into the path. The answer is the pass with `version` one higher.

## Guard against a stale write

Send `If-Match` with the `version` you last read. If someone else changed the pass first, the answer is `412 VERSION_CONFLICT`. In the console, add the If-Match chip and set an old version to see it.

Handle it by reading the pass again and retrying with the new `version`. See [VERSION_CONFLICT](/developers/errors/VERSION_CONFLICT).

## Read what changed

{{run pass-activity}}

The activity list shows the update and its new version, newest first. The pass detail lists every version.

## Void a pass

A voided pass shows as void and scans are refused. The record and its link stay.

{{run void-pass}}

Undo it:

{{run unvoid-pass}}

To end a pass for good, see [pass lifecycle](/developers/guides/pass-lifecycle).

## Result

Open the pass's `downloadUrl` after each call. The preview page shows the new field, and the void state after a void. Nothing is pushed in a sandbox; the preview and the activity list are the proof.
