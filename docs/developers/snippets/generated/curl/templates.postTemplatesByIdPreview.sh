curl -X POST "https://passbook.mobile/api/v1/templates/0193a1b2-7c00-7000-8000-0000000000b1/preview" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "version": "3",
  "input": {
    "name": "Ada Example",
    "tier": "Day pass",
    "validUntil": "2026-12-31"
  }
}'
