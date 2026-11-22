curl -X PATCH "https://passbook.mobile/api/v1/scanning-sessions/0193a1b2-7c00-7000-8000-0000000000e1" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "name": "Northwind Climbing",
  "timeZone": "America/Los_Angeles",
  "accepts": {
    "templateIds": [
      "0193a1b2-7c00-7000-8000-0000000000b1"
    ],
    "eventIds": [
      "0193a1b2-7c00-7000-8000-0000000000e1"
    ]
  }
}'
