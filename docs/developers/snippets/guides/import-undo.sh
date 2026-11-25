curl -X POST "https://passbook.mobile/api/v1/pass-imports/$IMPORT_ID/undo" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
