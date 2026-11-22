import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.templates.reviews.approve(
    "0193a1b2-7c00-7000-8000-0000000000b1",
    {
        "version": "4",
        "release": True,
        "note": "Logo and colors match the brand guide.",
    },
)
print(result)
