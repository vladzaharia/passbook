curl -X PUT "https://passbook.mobile/api/v1/message-rules/0193a1b2-7c00-7000-8000-0000000000e1" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "name": "Renewal reminder",
  "templateIds": [
    "0193a1b2-7c00-7000-8000-0000000000b1"
  ],
  "anchor": {
    "kind": "input",
    "input": "validUntil"
  },
  "offset": {
    "amount": 7,
    "unit": "day",
    "when": "before"
  },
  "yearly": false,
  "sendAt": "09:00",
  "timeZone": "America/Los_Angeles",
  "message": "Your membership renews in 7 days.",
  "version": 2
}'
