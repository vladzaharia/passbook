curl -X PATCH "https://passbook.mobile/api/v1/orgs/0193a1b2-7c00-7000-8000-0000000000a1/pass-setup?dryRun=true" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "expectedRevision": "test.1.0.0",
  "channels": {
    "mobile": "blocked"
  }
}'
