curl -X POST "https://passbook.mobile/api/v1/nfc/tag-types" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "name": "Day pass",
  "use": "member",
  "scopes": "pass",
  "perPass": 4,
  "bindingDays": 5
}'
