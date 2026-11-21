import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.nfc.tag_types.create(
    {
        "name": "Example",
        "use": "member",
    },
)
print(result)
