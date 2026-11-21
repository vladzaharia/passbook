import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.holders.offboard(
    {
        "holderEmail": "ada@example.com",
        "passes": "void",
        "dryRun": True,
    },
)
print(result)
