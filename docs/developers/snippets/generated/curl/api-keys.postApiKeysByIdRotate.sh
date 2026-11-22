curl -X POST "https://passbook.mobile/api/v1/api-keys/0193a1b2-7c00-7000-8000-0000000000e1/rotate" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "overlapHours": 2
}'
