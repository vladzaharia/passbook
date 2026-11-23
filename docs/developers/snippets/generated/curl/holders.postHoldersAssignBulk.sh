curl -X POST "https://passbook.mobile/api/v1/holders/assign-bulk" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "items": [
    {
      "passId": "0193a1b2-7c00-7000-8000-0000000000c1",
      "email": "ada@example.com"
    },
    {
      "passId": "0193a1b2-7c00-7000-8000-f3f85c24ee38",
      "email": "grace@example.com"
    }
  ]
}'
