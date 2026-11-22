curl -X POST "https://passbook.mobile/api/v1/passes/bulk" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
  "action": "void",
  "message": "The gym closes at 18:00 on 24 December.",
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "ids": [
    "0193a1b2-7c00-7000-8000-8b1bb892d676"
  ]
}'
