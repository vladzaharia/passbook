curl -X POST "https://passbook.mobile/api/v1/api-keys" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "name": "CI",
  "scopes": [
    "passes:read"
  ],
  "mode": "test"
}'
