import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.scanners.create(
    {
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "name": "Day pass",
        "kind": "device",
        "accepts": {
            "eventId": "0193a1b2-7c00-7000-8000-0000000000e1",
        },
        "settings": {
            "checkIn": {
                "mode": "single",
                "eventId": "0193a1b2-7c00-7000-8000-0000000000e1",
            },
            "direction": "in",
        },
        "timeZone": "America/Los_Angeles",
    },
)
print(result)
