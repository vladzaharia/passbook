curl -X POST "https://passbook.mobile/api/v1/templates/baked:starter-event-ticket/use" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "name": "Northwind Climbing",
  "version": {
    "passJson": {
      "formatVersion": 1,
      "passTypeIdentifier": "pass.mobile.passbook.northwind",
      "serialNumber": "0193a1b2-7c00-7000-8000-0000000000c2",
      "organizationName": "Northwind Climbing",
      "description": "Day pass",
      "backgroundColor": "rgb(17, 42, 74)",
      "foregroundColor": "rgb(255, 255, 255)",
      "labelColor": "rgb(255, 196, 0)",
      "generic": {
        "primaryFields": [
          {
            "key": "name",
            "label": "Guest",
            "value": "Ada Example"
          }
        ],
        "secondaryFields": [
          {
            "key": "tier",
            "label": "Pass",
            "value": "Day pass"
          }
        ],
        "auxiliaryFields": [
          {
            "key": "validUntil",
            "label": "Valid until",
            "value": "2026-12-31"
          }
        ]
      }
    },
    "manifest": {
      "tier": {}
    },
    "assets": [
      {
        "name": "Northwind Climbing",
        "sha1": "e6997603809dcf7d34d188068c529a7808556809"
      }
    ]
  },
  "baseVersion": "3"
}'
