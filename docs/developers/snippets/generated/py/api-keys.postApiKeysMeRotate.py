import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.api_keys.rotate_current(
    {
        "overlapHours": 3,
    },
)
print(result)
