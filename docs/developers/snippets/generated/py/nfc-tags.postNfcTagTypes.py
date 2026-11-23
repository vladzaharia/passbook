import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.nfc.tag_types.create(
    {
        "name": "Member wristband",
        "use": "member",
        "scopes": "pass",
        "perPass": 1,
    },
)
print(result)
