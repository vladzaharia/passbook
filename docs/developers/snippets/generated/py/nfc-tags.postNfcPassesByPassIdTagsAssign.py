import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.nfc.tags.assign(
    "0193a1b2-7c00-7000-8000-0000000000c1",
    {
        "id": "04A1B2C3D4E5F6",
        "format": "hex",
        "binding": "pass",
        "label": "Wristband 14",
    },
)
print(result)
