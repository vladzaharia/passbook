import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.webhook_endpoints.create(
    {
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "url": "https://northwind.example.com/p/xK3v9QmT2Lw8",
        "description": "A day pass for the climbing gym, scanned at the front desk.",
        "eventTypes": [
            "pass.issued",
        ],
        "templateIds": [
            "0193a1b2-7c00-7000-8000-0000000000b1",
        ],
    },
)
print(result)
