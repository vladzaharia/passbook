import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.webhook_endpoints.deliveries.bulk_replay(
    "0193a1b2-7c00-7000-8000-0000000000e1",
    {
        "from": 23,
        "to": 39,
        "include": "failed",
        "missing": False,
        "dryRun": False,
    },
)
print(result)
