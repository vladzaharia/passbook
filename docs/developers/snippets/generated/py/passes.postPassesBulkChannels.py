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
            "0193a1b2-7c00-7000-8000-665c0f4c3b8d",
        ],
        "notify": False,
        "replaceCodes": False,
        "dryRun": False,
    },
)
print(result)
