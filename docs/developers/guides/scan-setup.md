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

## The three presets

`preset` picks the defaults; send only what differs.

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
