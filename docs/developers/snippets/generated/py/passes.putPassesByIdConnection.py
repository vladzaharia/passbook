import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.passes.connection.update(
    "0193a1b2-7c00-7000-8000-0000000000c1",
    {
        "connectionId": "0193a1b2-7c00-7000-8000-0000000000e1",
        "externalRef": "Example",
    },
)
print(result)
