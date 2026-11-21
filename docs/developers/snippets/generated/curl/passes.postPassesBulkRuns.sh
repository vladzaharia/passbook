curl -X POST "https://passbook.mobile/api/v1/passes/bulk-runs" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "action": "void",
  "selection": {
    "filter": {
      "status": "active"
    },
    "expectCount": 442
  }
}'
