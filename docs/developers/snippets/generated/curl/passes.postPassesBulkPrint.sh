curl -X POST "https://passbook.mobile/api/v1/passes/bulk-print" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "ids": [
    "0193a1b2-7c00-7000-8000-7df1a6663d89"
  ],
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1"
}'
