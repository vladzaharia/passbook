import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.passes.match_photos(
    {
        "keys": [
            "NW-1001",
            "NW-1002",
        ],
    },
)
print(result)
