curl -X POST "https://passbook.mobile/api/v1/passes/bulk/channels" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "action": "off",
  "channels": [
    "paper"
  ],
  "ids": [
    "0193a1b2-7c00-7000-8000-0000000000c1",
    "0193a1b2-7c00-7000-8000-f3f85c24ee38"
  ],
  "notify": false,
  "dryRun": false
}'
