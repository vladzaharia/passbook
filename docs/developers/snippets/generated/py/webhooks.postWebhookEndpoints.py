import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.webhook_endpoints.create(
    {
        "url": "https://bookings.northwind.example.com/hooks/passbook",
        "description": "Front-desk check-in sync",
        "eventTypes": [
            "pass.issued",
            "pass.scanned",
        ],
        "templateIds": [
            "0193a1b2-7c00-7000-8000-0000000000b1",
        ],
    },
)
print(result)
