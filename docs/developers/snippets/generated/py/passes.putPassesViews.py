import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.pass_views.replace(
    {
        "items": [
            {
                "id": "expiring",
                "name": "Expiring this month",
                "filter": {
                    "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
                    "status": "active",
                },
            },
            {
                "id": "not-on-a-phone",
                "name": "Not on a phone yet",
                "filter": {
                    "onDevice": False,
                },
            },
        ],
        "revision": 2,
    },
)
print(result)
