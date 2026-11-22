curl -X POST "https://passbook.mobile/api/v1/roll-calls/0193a1b2-7c00-7000-8000-0000000000e1/marks" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "marks": [
    {
      "rollCallId": "0193a1b2-7c00-7000-8000-0000000000a1",
      "passId": "0193a1b2-7c00-7000-8000-0000000000a2",
      "status": "present",
      "at": 1764000000000
    }
  ]
}'
