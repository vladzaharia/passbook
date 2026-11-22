import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.pass_imports.commit(
    "0193a1b2-7c00-7000-8000-0000000000e1",
    {
        "skipInvalid": False,
        "email": {
            "send": "held",
            "holdMs": 300000,
        },
    },
)
print(result)
