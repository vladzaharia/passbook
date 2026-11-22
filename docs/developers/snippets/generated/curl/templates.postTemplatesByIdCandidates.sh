curl -X POST "https://passbook.mobile/api/v1/templates/0193a1b2-7c00-7000-8000-0000000000b1/candidates" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "mode": "test",
  "provider": "apple",
  "version": "example",
  "sourceReleaseId": "0193a1b2-7c00-7000-8000-0000000000a2",
  "projection": {}
}'
