curl -X POST "https://passbook.mobile/api/v1/broadcasts/preview" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
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
    ]
  },
  "patch": {
    "venueName": {
      "set": "Pier 9"
    }
  },
  "notify": false
}'
