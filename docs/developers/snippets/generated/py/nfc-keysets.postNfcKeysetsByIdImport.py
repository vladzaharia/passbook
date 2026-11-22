import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.nfc.keysets.import_tags(
    "0193a1b2-7c00-7000-8000-0000000000e1",
    {
        "csv": "name,email,tier\nAda Example,ada@example.com,Day pass\n",
        "dryRun": False,
    },
)
print(result)
