curl -X POST "https://passbook.mobile/api/v1/scan/actions" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -H "x-passbook-device: sandbox" \
  -d '{
  "idempotencyKey": "0193a1b2-7c00-7000-8000-0000000000f2",
  "input": {
    "passId": "0193a1b2-7c00-7000-8000-0000000000c1",
    "method": "manual"
  },
  "clientTs": 1795129200000,
  "actionId": "auto"
}'
