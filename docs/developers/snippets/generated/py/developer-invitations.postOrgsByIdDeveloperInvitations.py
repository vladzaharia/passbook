import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.developer_invitations.create(
    "0193a1b2-7c00-7000-8000-0000000000a1",
    {
        "email": "ada@example.com",
        "roles": [
            "read_only",
        ],
    },
)
print(result)
