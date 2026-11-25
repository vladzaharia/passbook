curl -X POST "https://passbook.mobile/api/v1/connections/uploads" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "name": "Example",
  "content": "Example",
  "encoding": "utf8"
}'
