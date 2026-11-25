curl -X POST "https://passbook.mobile/api/v1/scan/sign-out" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "x-passbook-device: door-1" \
  -H "Content-Type: application/json" \
  -d '{
  "idempotencyKey": "0193a1b2-7c00-7000-8000-0000000000aa",
  "passId": "0193a1b2-7c00-7000-8000-0000000000c1",
  "tag": "returned"
}'
