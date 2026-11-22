import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.passes.update(
    "0193a1b2-7c00-7000-8000-0000000000c1",
    {
        "input": {
            "name": "Ada Example",
            "tier": "Day pass",
            "validUntil": "2026-12-31",
        },
        "templateVersion": "3",
        "externalId": "0193a1b2-7c00-7000-8000-1ab96d5bf47b",
    },
)
print(result)
