import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.message_rules.update(
    "0193a1b2-7c00-7000-8000-0000000000e1",
    {
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "name": "Example",
        "templateIds": [
            "0193a1b2-7c00-7000-8000-0000000000b1",
        ],
        "anchor": {
            "kind": "input",
            "input": "Example",
        },
        "offset": {
            "amount": 0,
            "unit": "day",
            "when": "before",
        },
        "timeZone": "Europe/Berlin",
        "message": "Example",
        "version": 1,
    },
)
print(result)
