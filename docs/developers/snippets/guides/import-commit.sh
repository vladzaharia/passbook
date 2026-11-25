curl -X POST "https://passbook.mobile/api/v1/pass-imports/0193a1b2-7c00-7000-8000-0000000000e1/commit" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Idempotency-Key: qs-$(date +%s)-$RANDOM" \
  -H "Content-Type: application/json" \
  -d '{
  "skipInvalid": false,
  "email": {
    "send": "held",
    "holdMs": 300000
  }
}'
