curl -X POST "https://passbook.mobile/api/v1/templates/0193a1b2-7c00-7000-8000-0000000000b1/preview" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "input": {
    "eventName": "Friday Night Bouldering",
    "venueName": "Northwind Climbing",
    "venueRegion": "Seattle, WA",
    "startsAt": "2026-12-04T18:00:00-08:00",
    "endsAt": "2026-12-04T22:00:00-08:00",
    "attendee": "Ada Example",
    "ticketId": "NW-1001"
  }
}'
