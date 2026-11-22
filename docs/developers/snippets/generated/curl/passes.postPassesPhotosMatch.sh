curl -X POST "https://passbook.mobile/api/v1/passes/photos/match" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "keys": [
    "NW-1001",
    "NW-1002"
  ]
}'
