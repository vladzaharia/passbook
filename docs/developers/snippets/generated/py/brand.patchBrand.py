import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.brand.update(
    {
        "accent": "#ffc400",
        "mark": "full",
        "configRevision": 3,
    },
)
print(result)
