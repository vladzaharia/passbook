curl -X POST "https://passbook.mobile/api/v1/scanning-sessions/0193a1b2-7c00-7000-8000-0000000000e1/devices" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "name": "Ada Example",
  "surface": "auto"
}'
