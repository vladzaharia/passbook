curl -X POST "https://passbook.mobile/api/v1/connections/0193a1b2-7c00-7000-8000-0000000000e1/preview" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "arrivalId": "0193a1b2-7c00-7000-8000-f3168e33f525"
}'
