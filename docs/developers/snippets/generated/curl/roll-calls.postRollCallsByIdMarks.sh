curl -X POST "https://passbook.mobile/api/v1/roll-calls/0193a1b2-7c00-7000-8000-0000000000e1/marks" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "marks": [
    {
      "rollCallId": "0193a1b2-7c00-7000-8000-000000000072",
      "passId": "0193a1b2-7c00-7000-8000-0000000000c1",
      "status": "present",
      "at": 12
    }
  ]
}'
