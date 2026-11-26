import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.invitations.create(
    "0193a1b2-7c00-7000-8000-0000000000a1",
    {
        "email": "priya@example.com",
        "roles": [
            "pass_operator",
        ],
    },
)
print(result)
