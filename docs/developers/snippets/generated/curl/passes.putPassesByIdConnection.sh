curl -X PUT "https://passbook.mobile/api/v1/passes/0193a1b2-7c00-7000-8000-0000000000c1/connection" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "connectionId": "0193a1b2-7c00-7000-8000-000000000051",
  "externalRef": "booking_8841",
  "resetFieldSources": false
}'
