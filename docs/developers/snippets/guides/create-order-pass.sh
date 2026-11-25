curl -X POST "https://passbook.mobile/api/v1/passes" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Idempotency-Key: order-8841" \
  -H "Content-Type: application/json" \
  -d '{
  "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
  "externalId": "order-8841",
  "holderEmail": "ada@example.com",
  "input": {
    "eventName": "Harbor Night",
    "venueName": "Harbor Hall",
    "venueRegion": "Cupertino, CA",
    "startsAt": "2030-06-01T19:00:00-07:00",
    "endsAt": "2030-06-01T22:00:00-07:00",
    "attendee": "Ada Example",
    "ticketId": "TICKET-8841"
  }
}'
