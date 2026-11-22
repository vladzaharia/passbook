import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.scanners.create(
    {
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "name": "Example",
        "kind": "device",
        "accepts": {
            "eventId": "0193a1b2-7c00-7000-8000-0000000000e1",
        },
        "timeZone": "Europe/Berlin",
    },
)
print(result)
