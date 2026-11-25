curl -X POST "https://passbook.mobile/api/v1/broadcasts" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Idempotency-Key: qs-$(date +%s)-$RANDOM" \
  -H "Content-Type: application/json" \
  -d '{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "kind": "change",
  "name": "Move to Pier 9",
  "send": "now",
  "notify": false,
  "target": {
    "templateIds": [
      "0193a1b2-7c00-7000-8000-0000000000b1"
    ],
    "match": [
      {
        "input": "venueName",
        "values": [
          "Harbor Hall"
        ]
      }
    ],
    "expectCount": 1
  },
  "patch": {
    "venueName": {
      "set": "Pier 9"
    }
  }
}'
