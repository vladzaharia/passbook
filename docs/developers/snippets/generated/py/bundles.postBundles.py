import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.bundles.create(
    {
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "passIds": [
            "0193a1b2-7c00-7000-8000-0000000000c1",
        ],
        "name": "Family bundle",
        "holderEmail": "ada@example.com",
        "sendEmail": True,
    },
)
print(result)
