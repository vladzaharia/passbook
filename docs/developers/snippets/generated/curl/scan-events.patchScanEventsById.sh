curl -X PATCH "https://passbook.mobile/api/v1/scan-events/0193a1b2-7c00-7000-8000-0000000000e1" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "name": "Open climbing",
  "templateIds": [
    "0193a1b2-7c00-7000-8000-0000000000b1"
  ],
  "match": {
    "input": "tier",
    "values": [
      "Day pass"
    ]
  }
}'
