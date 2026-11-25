curl -X POST "https://passbook.mobile/api/v1/pass-imports" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
  "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
  "source": {
    "kind": "file",
    "name": "guests.csv",
    "csv": "attendee,ticket,email\nAda Example,TICKET-1001,ada@example.com\nGrace Host,TICKET-1002,grace@example.com\nAlan Guest,TICKET-1003,alan@example.com\nEdsger Visitor,TICKET-1004,edsger@example.com\nBarbara Member,TICKET-1005,barbara@example.com"
  }
}'
