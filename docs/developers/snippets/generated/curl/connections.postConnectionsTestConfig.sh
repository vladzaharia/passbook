curl -X POST "https://passbook.mobile/api/v1/connections/test-config" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "connectorType": "example",
  "config": {
    "example": {}
  },
  "secrets": {
    "example": "example"
  },
  "mapping": {
    "example": {
      "from": "example",
      "transform": {
        "kind": "enum",
        "options": {
          "example": {}
        }
      }
    }
  }
}'
