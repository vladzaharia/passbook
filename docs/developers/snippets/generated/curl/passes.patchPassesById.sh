curl -X PATCH "https://passbook.mobile/api/v1/passes/0193a1b2-7c00-7000-8000-0000000000c1" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "input": {
    "name": "Ada Example",
    "tier": "Day pass",
    "validUntil": "2026-12-31"
  },
  "templateVersion": "3",
  "externalId": "booking_8841"
}'
