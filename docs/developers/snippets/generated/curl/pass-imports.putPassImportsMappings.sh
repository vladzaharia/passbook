curl -X PUT "https://passbook.mobile/api/v1/pass-imports/mappings" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "name": "Members export",
  "columns": [
    "Holder email",
    "Name",
    "Tier",
    "Valid until",
    "Member ID"
  ],
  "plan": {
    "mapping": {
      "name": {
        "from": "/Name"
      },
      "tier": {
        "from": "/Tier"
      },
      "validUntil": {
        "from": "/Valid until",
        "transform": {
          "kind": "date",
          "options": {
            "input": "iso",
            "output": "iso"
          }
        }
      }
    },
    "holderEmail": {
      "from": "/Holder email"
    },
    "externalId": {
      "from": "/Member ID"
    },
    "match": "externalId",
    "keepManual": false,
    "save": true,
    "overrides": {}
  },
  "templateId": "0193a1b2-7c00-7000-8000-0000000000b1"
}'
