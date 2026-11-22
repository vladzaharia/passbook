import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.scanning_sessions.setup(
    {
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "preset": "front_desk",
        "timeZone": "America/Los_Angeles",
        "places": [
            {
                "zoneId": "0193a1b2-7c00-7000-8000-000000000081",
            },
        ],
        "doors": [
            {
                "name": "Day pass",
                "place": "northwind",
                "admits": {
                    "any": True,
                },
                "hours": "always",
            },
        ],
    },
)
print(result)
