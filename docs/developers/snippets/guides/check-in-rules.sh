curl -X PUT "https://passbook.mobile/api/v1/passes/0193a1b2-7c00-7000-8000-0000000000c1/check-in" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "rules": {
    "mode": "single",
    "validFrom": null,
    "validUntil": null
  }
}'
