curl -X PUT "https://passbook.mobile/api/v1/passes/views" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "items": [
    {
      "id": "0193a1b2-7c00-7000-8000-0000000000c1",
      "name": "Day pass",
      "filter": {
        "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
        "connectionId": "0193a1b2-7c00-7000-8000-000000000051"
      }
    }
  ],
  "revision": 3,
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1"
}'
