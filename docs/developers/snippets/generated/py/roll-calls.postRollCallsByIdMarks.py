import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.roll_calls.mark(
    "0193a1b2-7c00-7000-8000-0000000000e1",
    {
        "marks": [
            {
                "rollCallId": "0193a1b2-7c00-7000-8000-0000000000a1",
                "passId": "0193a1b2-7c00-7000-8000-0000000000a2",
                "status": "present",
                "at": 1764000000000,
            },
        ],
    },
)
print(result)
