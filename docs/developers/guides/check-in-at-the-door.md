---
id: check-in-at-the-door
title: Check in at the door
line: Scan and admit
status: ready
ops: passes.getPassesById
---
A till reads a pass's code and admits the holder. This guide sets the pass's check-in rules, then walks the till calls. Your sandbox answers them with test passes: no scanner is needed.

You need a pass: make one with [issue on purchase](/developers/guides/issue-on-purchase).

## Set the rules

`single` admits a pass once. Paste the pass `id` into the path.

{{run check-in-rules}}

## Read a code and admit

A till key names its device in `x-passbook-device` on every call; without it the answer is `422 DEVICE_REQUIRED`. `scan/resolve` shows what a code would do and records nothing. Use your pass's own scan code from its detail.

{{show door-check-in}}

Then `scan/actions` with `actionId: "auto"` applies the pass's check-in rule. Every call takes its own `idempotencyKey`, so a retry from a flaky connection is safe.

## Undo a scan

`POST /scan/scans/{scanId}/undo` reverses an admit made by mistake. See the [terminal reference](/developers/reference/terminal).

## Result

The resolve and action answers carry the outcome and the pass as the till would show it. The pass's activity list records each scan.
