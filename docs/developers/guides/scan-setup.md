---
id: scan-setup
title: Set up scanning in one call
line: Doors, staff, devices
status: ready
---
One request makes a door end to end: the places it counts, the events it admits, the staff who sign in, and the devices that scan. This guide previews a setup, applies it, and reads what comes back. You need a template: make one with [issue on purchase](/developers/guides/issue-on-purchase).

## Pick a key

- `scanning:write` makes places, events, sessions and devices. A test key makes test objects.
- `scanning:admin` also makes staff PINs and pairing codes. It is for a live key of one organization and is rate limited.

Without `scanning:admin` the answer has no PINs and no pairing codes. Pair devices from the console.

{{run current-key}}

`scopes` lists what the key may do. A sandbox has no Scanning devices: run the next calls with a key from your organization.

## Preview it

`?dryRun=true` runs every rule and writes nothing. It needs no `Idempotency-Key`. Each `checks` entry has a `level`: any `error` fails the real call with `422 SCAN_SETUP_CHECKS_FAILED`.

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

Front desk: one door, a counted place, staff with PINs.

```json
{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "preset": "front_desk",
  "places": [
    {
      "ref": "gym",
      "name": "Gym",
      "max": 60
    }
  ],
  "staff": [
    {
      "name": "Maya Chen",
      "role": "manager"
    },
    {
      "name": "Sam Ortiz",
      "role": "desk"
    }
  ],
  "doors": [
    {
      "name": "Front desk",
      "admits": {
        "templateIds": [
          "0193a1b2-7c00-7000-8000-0000000000b1"
        ]
      },
      "hours": {
        "every": [
          "06:00-22:00"
        ]
      },
      "place": "gym"
    }
  ]
}
```

Event night: one door that admits an event, open for the event's window.

```json
{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "preset": "event_night",
  "events": [
    {
      "ref": "gala",
      "name": "Saturday gala",
      "templateIds": [
        "0193a1b2-7c00-7000-8000-0000000000b1"
      ],
      "opensAt": 1795129200000,
      "closesAt": 1795212000000,
      "max": 300
    }
  ],
  "doors": [
    {
      "name": "Gala door",
      "admits": {
        "events": [
          "gala"
        ]
      },
      "devices": [
        {
          "layout": "phone"
        },
        {
          "layout": "phone"
        }
      ]
    }
  ]
}
```

Several areas: a door per area, each admitting its own pass types.

```json
{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "preset": "venue",
  "doors": [
    {
      "name": "Main door",
      "admits": {
        "templateIds": [
          "0193a1b2-7c00-7000-8000-0000000000b1"
        ]
      }
    },
    {
      "name": "VIP door",
      "admits": {
        "templateIds": [
          "0193a1b2-7c00-7000-8000-0000000000b1"
        ]
      }
    }
  ]
}
```

## Apply it

Send an `Idempotency-Key`. The same key and body replays the answer with `replayed: true`, the same ids, and no PINs or pairing codes. The same key with another body is `409 SCAN_SETUP_KEY_REUSED`.

{{show scan-setup-apply}}

PINs and pairing codes appear once, in this answer. Hand each device its `pairing.url`; the device opens it and joins. Staff sign in on the device with their PIN.

## Result

The preview lists the zones, events, staff and sessions the setup would make, with `checks` that say what to fix. Nothing is written until you apply.
