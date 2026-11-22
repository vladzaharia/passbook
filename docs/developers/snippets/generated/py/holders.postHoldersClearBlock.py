import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.holders.clear_block(
    {
        "passId": "0193a1b2-7c00-7000-8000-0000000000c1",
        "userId": "0193a1b2-7c00-7000-8000-000000000011",
    },
)
print(result)
