curl -X POST "https://passbook.mobile/api/v1/webhook-endpoints/capture" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
