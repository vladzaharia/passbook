import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.passes.bulk_apply(
    {
        "action": "void",
    },
)
print(result)
