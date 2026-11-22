curl -X POST "https://passbook.mobile/api/v1/webhook-endpoints" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "url": "https://northwind.example.com/p/xK3v9QmT2Lw8",
  "description": "A day pass for the climbing gym, scanned at the front desk.",
  "eventTypes": [
    "pass.issued"
  ],
  "templateIds": [
    "0193a1b2-7c00-7000-8000-0000000000b1"
  ]
}'
