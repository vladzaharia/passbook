curl -X POST "https://passbook.mobile/api/v1/nfc/passes/0193a1b2-7c00-7000-8000-0000000000c1/tags/assign" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "id": "04A1B2C3D4E5F6",
  "format": "hex",
  "binding": "pass",
  "label": "Wristband 14"
}'
