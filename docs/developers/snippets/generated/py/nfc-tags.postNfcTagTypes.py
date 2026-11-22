import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.nfc.tag_types.create(
    {
        "name": "Wristband 14",
        "use": "member",
        "scopes": "pass",
        "perPass": 3,
        "bindingDays": 3,
    },
)
print(result)
