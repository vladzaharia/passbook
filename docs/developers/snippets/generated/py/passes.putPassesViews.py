import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.pass_views.replace(
    {
        "items": [],
        "revision": 0,
    },
)
print(result)
