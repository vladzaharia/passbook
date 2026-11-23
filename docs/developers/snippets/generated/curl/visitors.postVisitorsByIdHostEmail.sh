curl -X POST "https://passbook.mobile/api/v1/visitors/0193a1b2-7c00-7000-8000-0000000000e1/host-email" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "timeZone": "America/Los_Angeles"
}'
