curl -X POST "https://passbook.mobile/api/v1/templates/$TEMPLATE_ID/review-requests" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
  "version": "<version>"
}'
