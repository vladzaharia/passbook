curl -X POST "https://passbook.mobile/api/v1/scan/resolve" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "x-passbook-device: door-1" \
  -H "Content-Type: application/json" \
  -d '{
  "idempotencyKey": "0193a1b2-7c00-7000-8000-000000000f01",
  "input": {
    "code": "PB-4F7K-92QX",
    "method": "camera"
  },
  "clientTs": 1764000000000
}'
