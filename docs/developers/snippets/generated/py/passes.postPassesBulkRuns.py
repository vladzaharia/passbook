import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.bulk_runs.start(
    {
        "action": "remove",
        "message": "Your day pass was replaced by a monthly membership.",
        "selection": {
            "filter": {
                "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
                "status": "active",
            },
            "expectCount": 128,
        },
    },
)
print(result)
