curl -X PUT "https://passbook.mobile/api/v1/message-rules/0193a1b2-7c00-7000-8000-0000000000e1" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "name": "Ada Example",
  "templateIds": [
    "0193a1b2-7c00-7000-8000-0000000000a2"
  ],
  "match": [
    {
      "input": "example",
      "values": [
        "example"
      ]
    }
  ],
  "anchor": {
    "kind": "input",
    "input": "example"
  },
  "offset": {
    "amount": 1,
    "unit": "day",
    "when": "before"
  },
  "yearly": false,
  "timeZone": "example",
  "message": "example",
  "version": 1
}'
