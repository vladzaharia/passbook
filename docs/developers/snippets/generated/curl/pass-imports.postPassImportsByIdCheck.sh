curl -X POST "https://passbook.mobile/api/v1/pass-imports/0193a1b2-7c00-7000-8000-0000000000e1/check" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "plan": {
    "mapping": {
      "eventName": {
        "from": "/Event"
      },
      "venueName": {
        "from": "/Venue"
      },
      "venueRegion": {
        "from": "/City"
      },
      "startsAt": {
        "from": "/Starts",
        "transform": {
          "kind": "date",
          "options": {
            "input": "iso",
            "output": "iso"
          }
        }
      },
      "endsAt": {
        "from": "/Ends",
        "transform": {
          "kind": "date",
          "options": {
            "input": "iso",
            "output": "iso"
          }
        }
      },
      "attendee": {
        "from": "/Attendee"
      },
      "ticketId": {
        "from": "/Ticket ID"
      }
    },
    "holderEmail": {
      "from": "/Holder email"
    },
    "externalId": {
      "from": "/Ticket ID"
    },
    "match": "externalId",
    "keepManual": false,
    "save": true,
    "overrides": {
      "3": {
        "/Starts": "2030-06-01T19:00:00-07:00"
      }
    }
  }
}'
