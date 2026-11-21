import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.scanning_sessions.setup(
    {
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "preset": "venue",
        "doors": [
            {
                "name": "Main door",
                "admits": {
                    "templateIds": [
                        "0193a1b2-7c00-7000-8000-0000000000b1",
                    ],
                },
            },
            {
                "name": "VIP door",
                "admits": {
                    "templateIds": [
                        "0193a1b2-7c00-7000-8000-0000000000b1",
                    ],
                },
            },
        ],
    },
)
print(result)
