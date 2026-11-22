import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.message_rules.count_due(
    {
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "name": "Ada Example",
        "templateIds": [
            "0193a1b2-7c00-7000-8000-0000000000a2",
        ],
        "match": [
            {
                "input": "example",
                "values": [
                    "example",
                ],
            },
        ],
        "anchor": {
            "kind": "input",
            "input": "example",
        },
        "offset": {
            "amount": 1,
            "unit": "day",
            "when": "before",
        },
        "yearly": False,
        "timeZone": "example",
        "message": "example",
    },
)
print(result)
