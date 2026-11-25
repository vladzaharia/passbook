curl -X POST "https://passbook.mobile/api/v1/scan/scans/0193a1b2-7c00-7000-8000-0000000000f4/undo" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -H "x-passbook-device: sandbox" \
  -d '{
  "idempotencyKey": "0193a1b2-7c00-7000-8000-0000000000f5"
}'
