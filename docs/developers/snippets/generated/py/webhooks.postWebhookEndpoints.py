import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.webhook_endpoints.create(
    {
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "url": "https://hooks.example.com/passbook",
        "description": "Booking system events",
        "eventTypes": [
            "pass.issued",
        ],
        "templateIds": [
            "0193a1b2-7c00-7000-8000-0000000000b1",
        ],
    },
)
print(result)
