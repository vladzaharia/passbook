curl -X POST "https://passbook.mobile/api/v1/orgs/0193a1b2-7c00-7000-8000-0000000000a1/brand-assets" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "slot": "logo",
  "png": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==",
  "x2": "logo@2x.png"
}'
