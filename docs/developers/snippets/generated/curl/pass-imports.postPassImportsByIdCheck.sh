curl -X POST "https://passbook.mobile/api/v1/pass-imports/0193a1b2-7c00-7000-8000-0000000000e1/check" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "plan": {
    "mapping": {
      "name": {
        "from": "Name"
      },
      "tier": {
        "from": "Tier"
      },
      "validUntil": {
        "from": "Valid until"
      }
    },
    "holderEmail": {
      "from": "Booking sheet",
      "transform": {
        "kind": "enum",
        "options": {
          "tier": {}
        }
      }
    },
    "externalId": {
      "from": "Booking sheet",
      "transform": {
        "kind": "enum",
        "options": {
          "tier": {}
        }
      }
    },
    "match": "externalId",
    "keepManual": false,
    "save": false
  }
}'
