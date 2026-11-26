import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.connections.preview(
    "0193a1b2-7c00-7000-8000-0000000000e1",
    {
        "arrivalId": "0193a1b2-7c00-7000-8000-f3168e33f525",
    },
)
print(result)
