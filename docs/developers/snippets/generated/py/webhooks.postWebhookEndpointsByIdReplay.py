import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.webhook_endpoints.deliveries.bulk_replay(
    "0193a1b2-7c00-7000-8000-0000000000e1",
    {
        "from": 1764000000000,
        "to": 1764003600000,
        "include": "failed",
        "dryRun": True,
    },
)
print(result)
