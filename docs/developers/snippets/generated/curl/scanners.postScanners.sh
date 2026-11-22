curl -X POST "https://passbook.mobile/api/v1/scanners" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "name": "Day pass",
  "kind": "device",
  "accepts": {
    "eventId": "0193a1b2-7c00-7000-8000-0000000000e1"
  },
  "settings": {
    "checkIn": {
      "mode": "single",
      "eventId": "0193a1b2-7c00-7000-8000-0000000000e1"
    },
    "direction": "in"
  },
  "timeZone": "America/Los_Angeles"
}'
