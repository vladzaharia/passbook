curl -X POST "https://passbook.mobile/api/v1/pass-imports/$IMPORT_ID/commit" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
  "skipInvalid": false,
  "email": {
    "send": "held",
    "holdMs": 300000
  }
}'
