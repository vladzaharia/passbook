curl -X POST "https://passbook.mobile/api/v1/message-rules" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "name": "Day-before reminder",
  "templateIds": [
    "0193a1b2-7c00-7000-8000-0000000000b1"
  ],
  "anchor": {
    "kind": "input",
    "input": "startsAt"
  },
  "offset": {
    "amount": 1,
    "unit": "day",
    "when": "before"
  },
  "timeZone": "Europe/Berlin",
  "message": "Tomorrow at 7 PM."
}'
