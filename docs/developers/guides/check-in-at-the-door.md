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

A till call needs a key and names the terminal in `x-passbook-device`.

- **Sandbox:** your key scans as the Sandbox terminal. It needs no pairing and no `scans:write`, and it acts in Test only. Any Test key of the sandbox with `passes:write` scans as it. Send `x-passbook-device: sandbox`.
- **Your organization:** use a key with `scans:write` bound to one of its terminals. Make terminals in Scanning and send the terminal's id.

{{show door-check-in}}

`scan/resolve` shows what a code would do and records nothing. `scan/actions` with `actionId: "auto"` applies the pass's check-in rule. Every call takes its own `idempotencyKey`, so a retry from a flaky connection is safe.

## Undo a scan

`POST /scan/scans/{scanId}/undo` reverses an admit made by mistake, inside the undo window and only for scans the same key made. See the [terminal reference](/developers/reference/terminal).

## Sign out

`POST /scan/sign-out` with a pass id marks the person out of every tracked place and collects a lent tag (`tag`: `returned`, or `not_returned` to report it lost). Send `read` instead of `passId` to tap the lent tag. The same `idempotencyKey` repeats the first answer. A terminal that is in no scanning session, or whose session has no zones, marks nobody out: the answer counts those places in `stillInside`.

## Result

The rules read back as you set them. The pass counts as admitted once; a second scan is refused. Open the pass's `downloadUrl`: the test preview shows the pass the till would read.
