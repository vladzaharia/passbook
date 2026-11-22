import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.api_keys.retire(
    "0193a1b2-7c00-7000-8000-0000000000e1",
    {
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "retireAt": 1795570500000,
    },
)
print(result)
