curl -X PATCH "https://passbook.mobile/api/v1/passes/$PASS_ID" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "If-Match: $VERSION" \
  -H "Content-Type: application/json" \
  -d '{
  "input": {
    "attendee": "Ada Lovelace"
  },
  "notify": true
}'
