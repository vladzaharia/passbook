curl -X PUT "https://passbook.mobile/api/v1/message-rules/0193a1b2-7c00-7000-8000-0000000000e1" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "name": "Renewal reminder",
  "templateIds": [
    "0193a1b2-7c00-7000-8000-0000000000b1"
  ],
  "match": [
    {
      "input": "tier",
      "values": [
        "Day pass"
      ]
    }
  ],
  "anchor": {
    "kind": "input",
    "input": "tier"
  },
  "offset": {
    "amount": 3,
    "unit": "day",
    "when": "before"
  },
  "yearly": false,
  "sendAt": "04:00",
  "timeZone": "America/Los_Angeles",
  "message": "The gym closes at 18:00 on 24 December.",
  "version": 3
}'
