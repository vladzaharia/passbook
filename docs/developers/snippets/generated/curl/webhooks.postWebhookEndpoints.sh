curl -X POST "https://passbook.mobile/api/v1/webhook-endpoints" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "url": "https://bookings.northwind.example.com/hooks/passbook",
  "description": "Front-desk check-in sync",
  "eventTypes": [
    "pass.issued",
    "pass.scanned"
  ],
  "templateIds": [
    "0193a1b2-7c00-7000-8000-0000000000b1"
  ]
}'
