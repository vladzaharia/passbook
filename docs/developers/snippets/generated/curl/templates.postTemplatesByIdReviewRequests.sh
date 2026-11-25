curl -X POST "https://passbook.mobile/api/v1/templates/0193a1b2-7c00-7000-8000-0000000000b1/review-requests" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Idempotency-Key: qs-$(date +%s)-$RANDOM" \
  -H "Content-Type: application/json" \
  -d '{
  "version": "4",
  "modes": [
    "test"
  ],
  "expected": {
    "test": 3
  }
}'
