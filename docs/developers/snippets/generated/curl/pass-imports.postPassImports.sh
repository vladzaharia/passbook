curl -X POST "https://passbook.mobile/api/v1/pass-imports" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
  "source": {
    "kind": "file",
    "name": "Example",
    "csv": "Example"
  }
}'
