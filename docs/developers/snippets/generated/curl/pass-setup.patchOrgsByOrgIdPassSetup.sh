curl -X PATCH "https://passbook.mobile/api/v1/orgs/0193a1b2-7c00-7000-8000-0000000000a1/pass-setup" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Idempotency-Key: qs-$(date +%s)-$RANDOM" \
  -H "Content-Type: application/json" \
  -d '{
  "expectedRevision": "4",
  "brand": {
    "accent": "#ffc400",
    "mark": "full"
  }
}'
