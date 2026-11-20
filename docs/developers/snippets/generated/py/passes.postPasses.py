import os, uuid
import httpx

res = httpx.post(
    "https://passbook.mobile/api/v1/passes",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}", "Idempotency-Key": str(uuid.uuid4())},
    json={
        "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
        "input": {
            "eventName": "Harbor Night",
            "venueName": "Harbor Hall",
            "venueRegion": "Cupertino, CA",
            "startsAt": "2030-06-01T19:00:00-07:00",
            "endsAt": "2030-06-01T22:00:00-07:00",
            "attendee": "Ada Example",
            "ticketId": "TICKET-0001",
        },
        "holderEmail": "ada@example.com",
        "externalId": "booking_8841",
    },
)
res.raise_for_status()
print(res.json())
