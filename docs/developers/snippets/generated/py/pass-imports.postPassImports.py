import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.pass_imports.create(
    {
        "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
        "source": {
            "kind": "file",
            "name": "Example",
            "csv": "Example",
        },
    },
)
print(result)
