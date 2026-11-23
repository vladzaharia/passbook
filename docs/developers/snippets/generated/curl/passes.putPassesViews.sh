curl -X PUT "https://passbook.mobile/api/v1/passes/views" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "items": [
    {
      "id": "expiring",
      "name": "Expiring this month",
      "filter": {
        "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
        "status": "active"
      }
    },
    {
      "id": "not-on-a-phone",
      "name": "Not on a phone yet",
      "filter": {
        "onDevice": false
      }
    }
  ],
  "revision": 2
}'
