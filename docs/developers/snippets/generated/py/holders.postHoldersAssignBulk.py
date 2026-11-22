import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.holders.bulk_assign(
    {
        "items": [
            {
                "passId": "0193a1b2-7c00-7000-8000-0000000000c1",
                "email": "ada@example.com",
            },
            {
                "passId": "0193a1b2-7c00-7000-8000-f3f85c24ee38",
                "email": "grace@example.com",
            },
        ],
    },
)
print(result)
