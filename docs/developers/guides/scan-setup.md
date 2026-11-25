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

## The presets

`preset` picks the defaults; send only what differs. A door's own value always wins; `hours: "always"` overrides a preset's hours.

| Preset | For | Fills |
| --- | --- | --- |
| `front_desk` | A staffed desk | Staff PIN; tablet and phone; lookup, photo, desk actions |
| `event_night` | Doors for an event | Anyone as Door; offline list when no exits |
| `venue` | Several areas | Nothing; one session per door |
| `club` | Self-serve members' door | Anyone as Door; an in phone and an out phone; in and out |
| `conference` | Badge desk, several days | Staff PIN; tablet and phone, both badge lanes; once a day; 08:00-18:00 |
| `gates` | Ticket gates | Anyone as Door; two phones and a phone with a barcode reader; one entry; offline list |
| `counter` | Café or loyalty counter | Staff PIN; tablet and customer screen; unlimited; the operator chooses the action |
| `pickup` | Pickup or will-call | Staff PIN; one tablet; one pickup per pass |
| `capacity` | Entry with a head limit | Anyone as Door; an in phone and an out phone; in and out; hard limit; 09:00-17:00 |

Notes:

- `conference` checks in once a day per pass, so use it for the badge desk. Make each room door its own session set to unlimited.
- `gates` with the offline list: each gate decides alone offline, and a duplicate shows after sync.
- `capacity` needs a place with `max`. A hard limit with no max is refused with `SETUP_HARD_LIMIT_NO_CAPACITY`.
- `counter` needs staff PINs so charges and stamps are attributed.

Add `places`, `events` and `staff` as the door needs them, and name them with a `ref` that doors use.

## Apply it

Send an `Idempotency-Key`. The same key and body replays the answer with `replayed: true` and the same ids. The same key with another body is [409 SCAN_SETUP_KEY_REUSED](/developers/errors/SCAN_SETUP_KEY_REUSED).

{{show scan-setup-apply}}

> **Warning:** PINs and pairing codes appear once, in this answer. A replay never repeats them.

Hand each device its `pairing.url`. The device opens it and joins, and staff sign in with their PIN.

## Result

In your organization the preview lists the places, events, staff and sessions the setup would make, with `checks` that say what to fix, and nothing is written until you apply. In a sandbox both calls answer `403 FEATURE_NOT_INCLUDED` and write nothing.
