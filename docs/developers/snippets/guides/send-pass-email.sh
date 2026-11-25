curl -X POST "https://passbook.mobile/api/v1/passes/$PASS_ID/resend-email" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "to": "ada@example.com"
}'
