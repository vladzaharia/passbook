import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.terminal.sign_out_everywhere(
    {
        "idempotencyKey": "0193a1b2-7c00-7000-8000-0000000000aa",
        "passId": "0193a1b2-7c00-7000-8000-0000000000c1",
        "tag": "returned",
    },
)
print(result)
