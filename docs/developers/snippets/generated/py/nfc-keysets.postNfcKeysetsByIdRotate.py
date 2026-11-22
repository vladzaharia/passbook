import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.nfc.keysets.rotate(
    "0193a1b2-7c00-7000-8000-0000000000e1",
    {
        "generate": True,
    },
)
print(result)
