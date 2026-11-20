curl -X PATCH "https://passbook.mobile/api/v1/broadcasts/0193a1b2-7c00-7000-8000-0000000000e1" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "kind": "message",
  "target": {
    "templateIds": [
      "0193a1b2-7c00-7000-8000-0000000000b1"
    ]
  },
  "patch": {
    "message": "Doors open at 6:30 PM."
  }
}'
