curl -X POST "https://passbook.mobile/api/v1/scan-events" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "name": "Saturday gala",
  "templateIds": [
    "0193a1b2-7c00-7000-8000-0000000000b1"
  ],
  "opensAt": 1795129200000,
  "closesAt": 1795212000000,
  "timeZone": "Europe/Berlin"
}'
