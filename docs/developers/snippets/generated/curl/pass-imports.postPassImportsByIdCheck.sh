curl -X POST "https://passbook.mobile/api/v1/pass-imports/0193a1b2-7c00-7000-8000-0000000000e1/check" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "plan": {
    "mapping": {},
    "holderEmail": {
      "from": "Example"
    },
    "externalId": {
      "from": "Example"
    },
    "match": "externalId"
  }
}'
