import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.templates.reviews.request(
    "0193a1b2-7c00-7000-8000-0000000000b1",
    {
        "version": "4",
        "modes": [
            "live",
        ],
        "expected": {
            "live": 3,
        },
    },
)
print(result)
