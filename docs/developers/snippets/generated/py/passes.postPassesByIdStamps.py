import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.passes.stamps.apply(
    "0193a1b2-7c00-7000-8000-0000000000c1",
    {
        "action": "add",
        "count": 12,
    },
)
print(result)
