curl -X POST "https://passbook.mobile/api/v1/visitors" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "name": "Ada Example",
  "hostName": "Grace Host",
  "hostEmail": "grace@example.com",
  "windowFrom": 1764000000000,
  "windowUntil": 1764086400000
}'
