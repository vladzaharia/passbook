import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.message_rules.send_test(
    "0193a1b2-7c00-7000-8000-0000000000e1",
    {
        "passId": "0193a1b2-7c00-7000-8000-0000000000a1",
    },
)
print(result)
