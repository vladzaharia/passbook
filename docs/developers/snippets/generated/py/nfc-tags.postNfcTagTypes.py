import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.nfc.tag_types.create(
    {
        "name": "Northwind Climbing",
        "use": "member",
        "scopes": "pass",
        "perPass": 4,
        "bindingDays": 5,
    },
)
print(result)
