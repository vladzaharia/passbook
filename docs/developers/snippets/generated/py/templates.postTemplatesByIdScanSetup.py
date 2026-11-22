import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.templates.set_up_scanning(
    "0193a1b2-7c00-7000-8000-0000000000b1",
    {
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "timeZone": "America/Los_Angeles",
    },
)
print(result)
