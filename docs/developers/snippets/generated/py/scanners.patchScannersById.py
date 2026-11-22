import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.scanners.update(
    "0193a1b2-7c00-7000-8000-0000000000e1",
    {
        "name": "Day pass",
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
    },
)
print(result)
