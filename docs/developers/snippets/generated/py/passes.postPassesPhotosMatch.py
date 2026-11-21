import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.passes.match_photos(
    {
        "keys": [
            "Example",
        ],
    },
)
print(result)
