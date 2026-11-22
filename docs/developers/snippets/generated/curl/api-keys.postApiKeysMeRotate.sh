curl -X POST "https://passbook.mobile/api/v1/api-keys/me/rotate" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "overlapHours": 2
}'
