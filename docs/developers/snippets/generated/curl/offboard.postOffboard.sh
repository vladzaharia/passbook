curl -X POST "https://passbook.mobile/api/v1/offboard" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "holderEmail": "ada@example.com",
  "passes": "void",
  "dryRun": true
}'
