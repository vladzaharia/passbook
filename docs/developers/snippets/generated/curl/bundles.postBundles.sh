curl -X POST "https://passbook.mobile/api/v1/bundles" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "passIds": [
    "0193a1b2-7c00-7000-8000-0000000000c1"
  ],
  "name": "Family bundle",
  "holderEmail": "ada@example.com",
  "sendEmail": true
}'
