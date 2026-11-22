import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.passes.bulk_update_channels(
    {
        "action": "on",
        "channels": [
            "mobile",
        ],
        "ids": [
            "0193a1b2-7c00-7000-8000-0000000000a1",
        ],
        "notify": False,
        "replaceCodes": False,
    },
)
print(result)
