import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.message_rules.count_due(
    {
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "name": "Northwind Climbing",
        "templateIds": [
            "0193a1b2-7c00-7000-8000-0000000000b1",
        ],
        "match": [
            {
                "input": "tier",
                "values": [
                    "Day pass",
                ],
            },
        ],
        "anchor": {
            "kind": "input",
            "input": "tier",
        },
        "offset": {
            "amount": 14,
            "unit": "day",
            "when": "before",
        },
        "yearly": False,
        "sendAt": "04:00",
        "timeZone": "America/Los_Angeles",
        "message": "The gym closes at 18:00 on 24 December.",
    },
)
print(result)
