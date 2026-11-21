curl -X POST "https://passbook.mobile/api/v1/passes/0193a1b2-7c00-7000-8000-0000000000c1/resend-email" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
  "to": "ada@example.com",
  "attach": true
}'
