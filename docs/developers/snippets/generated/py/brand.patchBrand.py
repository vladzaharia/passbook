import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.brand.update(
    {
        "accent": "#1a73e8",
        "mark": "full",
    },
)
print(result)
