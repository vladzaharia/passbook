curl -X PUT "https://passbook.mobile/api/v1/pass-imports/mappings" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "templateId": "0197f1c2-6f3a-7b11-9c1e-2a5d4c8e9b10",
  "name": "Gym export",
  "columns": [
    "Member #",
    "Name",
    "Holder email"
  ],
  "plan": {
    "mapping": {
      "memberName": {
        "from": "/Name"
      }
    },
    "holderEmail": {
      "from": "/Holder email"
    },
    "externalId": {
      "from": "/Member #"
    },
    "match": "externalId",
    "keepManual": false,
    "save": true
  }
}'
