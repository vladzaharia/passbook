import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.broadcasts.count_recipients(
    {
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "target": {
            "templateIds": [
                "0193a1b2-7c00-7000-8000-0000000000b1",
            ],
        },
        "patch": {
            "validUntil": "2027-01-31",
        },
        "notify": True,
    },
)
print(result)
