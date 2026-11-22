import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.scan_events.update(
    "0193a1b2-7c00-7000-8000-0000000000e1",
    {
        "name": "Day pass",
        "templateIds": [
            "0193a1b2-7c00-7000-8000-0000000000b1",
        ],
        "match": {
            "input": "tier",
            "values": [
                "Day pass",
            ],
        },
    },
)
print(result)
