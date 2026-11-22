import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.pass_views.replace(
    {
        "items": [
            {
                "id": "northwind",
                "name": "Monthly membership",
                "filter": {
                    "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
                    "connectionId": "0193a1b2-7c00-7000-8000-000000000051",
                },
            },
        ],
        "revision": 3,
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
    },
)
print(result)
