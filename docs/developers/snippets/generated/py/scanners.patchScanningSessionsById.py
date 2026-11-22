import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.scanning_sessions.update(
    "0193a1b2-7c00-7000-8000-0000000000e1",
    {
        "name": "Day pass",
        "timeZone": "America/Los_Angeles",
        "accepts": {
            "templateIds": [
                "0193a1b2-7c00-7000-8000-0000000000b1",
            ],
            "eventIds": [
                "0193a1b2-7c00-7000-8000-0000000000e1",
            ],
        },
    },
)
print(result)
