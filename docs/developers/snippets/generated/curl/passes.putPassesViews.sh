curl -X PUT "https://passbook.mobile/api/v1/passes/views" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "items": []
}'
