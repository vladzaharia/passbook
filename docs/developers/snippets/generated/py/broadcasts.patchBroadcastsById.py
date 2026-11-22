import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.broadcasts.update(
    "0193a1b2-7c00-7000-8000-0000000000e1",
    {
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "kind": "message",
        "target": {
            "templateIds": [
                "0193a1b2-7c00-7000-8000-0000000000b1",
            ],
        },
        "patch": {
            "message": "Doors open at 6:30 PM.",
        },
    },
)
print(result)
