import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.terminal.act(
    {
        "idempotencyKey": "0193a1b2-7c00-7000-8000-000000000f02",
        "input": {
            "code": "PB-4F7K-92QX",
            "method": "camera",
        },
        "clientTs": 1764000000000,
        "actionId": "auto",
    },
    headers={
        "x-passbook-device": "door-1",
    },
)
print(result)
