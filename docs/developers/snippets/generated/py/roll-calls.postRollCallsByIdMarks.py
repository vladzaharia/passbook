import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.roll_calls.mark(
    "0193a1b2-7c00-7000-8000-0000000000e1",
    {
        "marks": [
            {
                "rollCallId": "0193a1b2-7c00-7000-8000-000000000072",
                "passId": "0193a1b2-7c00-7000-8000-0000000000c1",
                "status": "present",
                "at": 12,
            },
        ],
    },
)
print(result)
