import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.bulk_runs.start(
    {
        "action": "void",
        "selection": {
            "filter": {
                "status": "active",
            },
            "expectCount": 442,
        },
    },
)
print(result)
