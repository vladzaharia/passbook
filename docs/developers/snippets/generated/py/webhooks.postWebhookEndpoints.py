import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.webhook_endpoints.create(
    {
        "url": "https://hooks.example.com/passbook",
        "description": "Order system",
        "eventTypes": [
            "pass.issued",
            "pass.scanned",
        ],
    },
)
print(result)
