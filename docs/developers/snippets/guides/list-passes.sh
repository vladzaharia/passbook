curl -X GET "https://passbook.mobile/api/v1/passes?status=active&limit=100" \
  -H "Authorization: Bearer $PASSBOOK_KEY"
