curl -X POST "https://passbook.mobile/api/v1/templates/0193a1b2-7c00-7000-8000-0000000000b1/review-requests" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "version": "3",
  "modes": [
    "live"
  ],
  "expected": {
    "live": 3,
    "test": 3
  }
}'
