curl -X POST "https://passbook.mobile/api/v1/connections/test-config" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "connectorType": "csv-url",
  "config": {
    "url": "https://docs.google.com/spreadsheets/d/e/2PACX-northwind-bookings/pub?output=csv",
    "idColumn": "Booking ID"
  },
  "mapping": {
    "name": {
      "from": "/Name"
    },
    "tier": {
      "from": "/Plan"
    },
    "validUntil": {
      "from": "/Valid until"
    }
  }
}'
