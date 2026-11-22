import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.passes.bulk_update_channels(
    {
        "action": "off",
        "channels": [
            "paper",
        ],
        "ids": [
            "0193a1b2-7c00-7000-8000-0000000000c1",
            "0193a1b2-7c00-7000-8000-f3f85c24ee38",
        ],
        "notify": False,
        "dryRun": False,
    },
)
print(result)
