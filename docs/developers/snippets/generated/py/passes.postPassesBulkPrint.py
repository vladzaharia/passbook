import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.print_jobs.create(
    {
        "ids": [
            "0193a1b2-7c00-7000-8000-0000000000a1",
        ],
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a2",
    },
)
print(result)
