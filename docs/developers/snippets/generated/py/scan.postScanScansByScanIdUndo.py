import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.terminal.scans.undo(
    "0193a1b2-7c00-7000-8000-0000000000e1",
    {
        "idempotencyKey": "0193a1b2-7c00-7000-8000-000000000f03",
    },
    headers={
        "x-passbook-device": "door-1",
    },
)
print(result)
