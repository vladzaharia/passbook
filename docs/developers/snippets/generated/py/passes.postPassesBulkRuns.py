import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.bulk_runs.start(
    {
        "action": "void",
        "message": "The gym closes at 18:00 on 24 December.",
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "selection": {
            "filter": {
                "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
                "connectionId": "0193a1b2-7c00-7000-8000-000000000051",
            },
            "expectCount": 18,
        },
    },
)
print(result)
