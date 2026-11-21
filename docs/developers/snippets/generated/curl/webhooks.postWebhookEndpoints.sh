curl -X POST "https://passbook.mobile/api/v1/webhook-endpoints" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "url": "https://hooks.example.com/passbook",
  "description": "Order system",
  "eventTypes": [
    "pass.issued",
    "pass.scanned"
  ]
}'
