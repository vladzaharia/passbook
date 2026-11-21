import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.webhook_endpoints.send_test(
    "0193a1b2-7c00-7000-8000-0000000000e1",
    {
        "type": "pass.updated",
    },
)
print(result)
