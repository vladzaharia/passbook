curl -X POST "https://passbook.mobile/api/v1/passes" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Idempotency-Key: qs-$(date +%s)-$RANDOM" \
  -H "Content-Type: application/json" \
  -d '{
  "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
  "input": {
    "name": "Ada Example",
    "tier": "Day pass",
    "validUntil": "2026-12-31"
  },
  "holderEmail": "ada@example.com",
  "externalId": "booking_8841",
  "sendEmail": true
}'
