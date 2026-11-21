curl -X PUT "https://passbook.mobile/api/v1/message-rules/0193a1b2-7c00-7000-8000-0000000000e1" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "name": "Example",
  "templateIds": [
    "0193a1b2-7c00-7000-8000-0000000000b1"
  ],
  "anchor": {
    "kind": "input",
    "input": "Example"
  },
  "offset": {
    "amount": 0,
    "unit": "day",
    "when": "before"
  },
  "timeZone": "Europe/Berlin",
  "message": "Example",
  "version": 1
}'
