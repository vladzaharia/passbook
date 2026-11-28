import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.connections.links.create(
    "0193a1b2-7c00-7000-8000-0000000000e1",
    {
        "objectType": "invoice",
        "externalId": "booking_8841",
        "localId": "0193a1b2-7c00-7000-8000-0059709b2a3c",
    },
)
print(result)
