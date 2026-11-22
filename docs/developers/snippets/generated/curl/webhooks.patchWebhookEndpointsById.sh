curl -X PATCH "https://passbook.mobile/api/v1/webhook-endpoints/0193a1b2-7c00-7000-8000-0000000000e1" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "url": "https://northwind.example.com/p/xK3v9QmT2Lw8",
  "description": "",
  "eventTypes": [
    "pass.issued"
  ]
}'
