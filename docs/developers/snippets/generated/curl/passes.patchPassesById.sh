curl -X PATCH "https://passbook.mobile/api/v1/passes/0193a1b2-7c00-7000-8000-0000000000c1" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "input": {
    "endsAt": "2026-12-04T23:00:00-08:00"
  },
  "notify": true
}'
