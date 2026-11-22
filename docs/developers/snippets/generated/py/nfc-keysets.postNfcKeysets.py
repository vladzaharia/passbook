import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.nfc.keysets.create(
    {
        "name": "Staff badges",
        "generate": True,
    },
)
print(result)
