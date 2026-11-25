import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.passes.create(
    {
        "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
        "input": {
            "name": "Ada Example",
            "tier": "Day pass",
            "validUntil": "2026-12-31",
        },
        "holderEmail": "ada@example.com",
        "externalId": "booking_8841",
        "sendEmail": True,
    },
)
print(result)
