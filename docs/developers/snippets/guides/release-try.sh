curl -X POST "https://passbook.mobile/api/v1/templates/$TEMPLATE_ID/release" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Idempotency-Key: try-<version>" \
  -H "Content-Type: application/json" \
  -d '{
  "version": "<version>",
  "modes": [
    "test"
  ]
}'
