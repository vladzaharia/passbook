curl -X POST "https://passbook.mobile/api/v1/webhook-endpoints" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "url": "https://example.com/passbook",
  "eventTypes": [
    "pass.issued",
    "pass.updated",
    "pass.voided"
  ]
}'
