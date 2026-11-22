import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.templates.preview(
    "0193a1b2-7c00-7000-8000-0000000000b1",
    {
        "version": "3",
        "input": {
            "name": "Ada Example",
            "tier": "Day pass",
            "validUntil": "2026-12-31",
        },
    },
)
print(result)
