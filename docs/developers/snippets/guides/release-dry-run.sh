curl -X POST "https://passbook.mobile/api/v1/templates/$TEMPLATE_ID/release?dryRun=true" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "version": "<version>",
  "modes": [
    "test"
  ]
}'
