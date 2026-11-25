---
id: scan-setup
title: Set up scanning in one call
line: Doors, staff, devices
status: ready
---
One request makes a door end to end. You end with a previewed setup, an applied one, and the PINs and pairing links it returns once. You need a template: make one with [issue on purchase](/developers/guides/issue-on-purchase).

> **Sandbox:** [403 FEATURE_NOT_INCLUDED](/developers/errors/FEATURE_NOT_INCLUDED). A sandbox has no Scanning devices, so both calls below are refused there. Run them with a key from your organization, or do the same in its admin: Scanning, Set up scanning.

| Term | Meaning |
| --- | --- |
| Place | A counted area, with an optional `max`. |
| Event | A dated admission window for one or more templates. |
| Door | What a terminal guards: the templates or events it admits, its hours and its place. |
| Session | A door's scanning period, made for you. |
| Device | A phone or screen that scans at a door. It joins with a pairing link. |
| Staff | People who sign in on a device with a PIN. |

## Pick a key

- `scanning:write` makes places, events, sessions and devices. A test key makes test objects.
- `scanning:admin` also makes staff PINs and pairing codes. It is for a live key of one organization and is rate limited.

Without `scanning:admin` the answer has no PINs and no pairing codes. Pair devices from the console.

{{run current-key}}

`scopes` lists what the key may do.

## Preview it

`?dryRun=true` runs every rule and writes nothing, and needs no `Idempotency-Key`. Each `checks` entry has a `level`: any `error` fails the real call with [422 SCAN_SETUP_CHECKS_FAILED](/developers/errors/SCAN_SETUP_CHECKS_FAILED).

{{show scan-setup-preview}}

`preset` picks the defaults; send only what differs.

| Preset | Each door fills in |
| --- | --- |
| `front_desk` | Staff sign in with PINs, an operator device and an auto device, lookup, photo and desk actions. |
| `event_night` | Anyone scans as the door. A door with an operator device uses staff and lookup. |
| `venue` | Nothing. One session per door, directions from its places. |

Add `places`, `events` and `staff` as the door needs them, and name them with a `ref` that doors use.

## Apply it

Send an `Idempotency-Key`. The same key and body replays the answer with `replayed: true` and the same ids. The same key with another body is [409 SCAN_SETUP_KEY_REUSED](/developers/errors/SCAN_SETUP_KEY_REUSED).

{{show scan-setup-apply}}

> **Warning:** PINs and pairing codes appear once, in this answer. A replay never repeats them.

Hand each device its `pairing.url`. The device opens it and joins, and staff sign in with their PIN.

## Result

In your organization the preview lists the places, events, staff and sessions the setup would make, with `checks` that say what to fix, and nothing is written until you apply. In a sandbox both calls answer `403 FEATURE_NOT_INCLUDED` and write nothing.
