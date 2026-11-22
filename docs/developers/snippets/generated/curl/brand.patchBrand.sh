curl -X PATCH "https://passbook.mobile/api/v1/brand" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "accent": "#ffc400",
  "mark": "full",
  "configRevision": 3
}'
