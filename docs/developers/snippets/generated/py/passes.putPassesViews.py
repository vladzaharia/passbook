import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.passes.replace_views(
    {
        "items": [],
    },
)
print(result)
