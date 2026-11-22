---
id: check-in-at-the-door
title: Check in at the door
line: Scan and admit
status: ready
ops: passes.getPassesById
---
A till reads a pass's code and admits the holder. This guide sets the pass's check-in rules and shows the till calls. You need a pass: make one with [issue on purchase](/developers/guides/issue-on-purchase).

## Set the rules

`single` admits a pass once. Paste the pass `id` into the path.

{{run check-in-rules}}

Read them back with [the rules](console:passes.getPassesByIdCheckIn).

## Find the code

A till reads the code the pass's barcode carries. It is `passJson.barcodes[0].message` in the pass detail; the QR on the pass encodes it.

## Call the till

A till call needs a key bound to a terminal, and names the terminal in `x-passbook-device`. Terminals belong to Scanning in an organization, and a sandbox key never holds `scans:write`: its till calls get `403 MISSING_SCOPE`. Run these with a till key from your organization.

{{show door-check-in}}

`scan/resolve` shows what a code would do and records nothing. `scan/actions` with `actionId: "auto"` applies the pass's check-in rule. Every call takes its own `idempotencyKey`, so a retry from a flaky connection is safe.

## Undo a scan

`POST /scan/scans/{scanId}/undo` reverses an admit made by mistake, inside the undo window and only for scans the same key made. See the [terminal reference](/developers/reference/terminal).

## Result

The rules read back as you set them. Open the pass's `downloadUrl`: the test preview shows the pass the till would read.
