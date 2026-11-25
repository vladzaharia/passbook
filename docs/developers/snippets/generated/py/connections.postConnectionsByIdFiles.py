import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.connections.files.upload(
    "0193a1b2-7c00-7000-8000-0000000000e1",
    {
        "name": "Example",
        "content": "Example",
        "encoding": "utf8",
    },
)
print(result)
