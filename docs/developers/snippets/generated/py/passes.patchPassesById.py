import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.passes.update(
    "0193a1b2-7c00-7000-8000-0000000000c1",
    {
        "input": {
            "endsAt": "2026-12-04T23:00:00-08:00",
        },
        "notify": True,
    },
)
print(result)
