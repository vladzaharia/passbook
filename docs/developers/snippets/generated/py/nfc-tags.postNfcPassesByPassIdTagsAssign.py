import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.nfc.tags.assign(
    "0193a1b2-7c00-7000-8000-0000000000c1",
    {
        "id": "0193a1b2-7c00-7000-8000-000000000082",
        "format": "hex",
        "binding": "pass",
        "label": "Wristband 14",
    },
)
print(result)
