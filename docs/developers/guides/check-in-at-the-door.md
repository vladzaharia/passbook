---
id: check-in-at-the-door
title: Check in at the door
line: Scan and admit
status: ready
ops: passes.getPassesById
---
A terminal reads a pass and admits the holder. You end with a pass admitted once, a second scan answered `already_done`, and the admit undone. You need a pass: make one with [issue on purchase](/developers/guides/issue-on-purchase). Its ticket starts in 2030, which the first step shows.

## Scan the pass early

Every terminal call names its terminal in `x-passbook-device` and sends an `idempotencyKey` in the body, not in the `Idempotency-Key` header. The key must be a UUID v7: version digit 7. A v4 from `uuidgen` is refused with [422 VALIDATION](/developers/errors/VALIDATION). Make one with `uuidgen | tr A-Z a-z | sed -E 's/^(.{14})4/\17/'`.

- **Sandbox:** your key scans as the Sandbox terminal. Send `x-passbook-device: sandbox`. It needs no pairing and no `scans:write`, and it acts in Test only.
- **Your organization:** use a key with `scans:write` bound to one of its terminals. Make terminals in Scanning and send the terminal's id.

{{show door-resolve}}

`resolve` shows what a scan would do and records nothing. The answer is `kind: heads_up`, `reason: not_yet_valid`, and `at`: when the ticket opens, in 2030. A camera terminal sends the code the pass's barcode carries (`input.code`, `method: camera`); this guide sends the pass `id` with `method: manual`, which finds the same pass.

## Lift the ticket's dates

`single` admits a pass once. A pass's check-in window defaults to its ticket's start and end; `null` removes both. In your organization, set them as epoch milliseconds. Paste the pass `id` into the path.

{{run check-in-rules}}

Read them back with [the rules](console:passes.getPassesByIdCheckIn).

## Admit the pass

{{show door-check-in}}

`actionId: "auto"` applies the pass's rule. The answer is `kind: ok`. Keep its `scanId` and `undoUntil`.

## Scan it again

Send a new `idempotencyKey`. The same key replays the first answer.

{{show door-again}}

The answer is `kind: heads_up`, `reason: already_done`. Nothing was admitted.

## Undo a scan

Undo reverses an admit made by mistake, before `undoUntil` and only for scans the same key made. Paste the `scanId` from the admit answer, not from the second scan: it has nothing to undo.

{{show undo-scan}}

See the [terminal reference](/developers/reference/terminal).

## If it fails

| Code | Cause | Fix |
| --- | --- | --- |
| [422 DEVICE_REQUIRED](/developers/errors/DEVICE_REQUIRED) | No `x-passbook-device`. | Send `sandbox`, or your terminal's id. |
| [404 TERMINAL_NOT_FOUND](/developers/errors/TERMINAL_NOT_FOUND) | The header names no terminal this key may act as. | In a sandbox send `sandbox`. Elsewhere send a terminal of your organization. |
| [422 VALIDATION](/developers/errors/VALIDATION) | `idempotencyKey` is not a UUID v7. | Set the version digit to 7. |
| [404 SCAN_NOT_FOUND](/developers/errors/SCAN_NOT_FOUND) | The scan is not an admit of this key. | Undo the `scanId` of the admit. |

## Result

The admit answered `ok`, and the second scan answered `already_done`. After the undo the pass admits again.
