import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.connections.uploads.create(
    {
        "name": "Example",
        "content": "Example",
        "encoding": "utf8",
    },
)
print(result)
