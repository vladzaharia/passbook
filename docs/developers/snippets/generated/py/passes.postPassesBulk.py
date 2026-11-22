import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.passes.bulk_apply(
    {
        "action": "void",
        "message": "The gym closes at 18:00 on 24 December.",
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "ids": [
            "0193a1b2-7c00-7000-8000-8b1bb892d676",
        ],
    },
)
print(result)
