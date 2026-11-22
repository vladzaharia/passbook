import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.templates.reviews.approve(
    "0193a1b2-7c00-7000-8000-0000000000b1",
    {
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "version": "3",
        "release": False,
        "note": "Needs a harness fitting.",
    },
)
print(result)
