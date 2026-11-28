curl -X POST "https://passbook.mobile/api/v1/connections/0193a1b2-7c00-7000-8000-0000000000e1/links" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "objectType": "invoice",
  "externalId": "booking_8841",
  "localId": "0193a1b2-7c00-7000-8000-0059709b2a3c"
}'
