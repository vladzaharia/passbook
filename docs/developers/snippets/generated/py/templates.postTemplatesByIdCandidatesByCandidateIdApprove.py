import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.templates.candidates.approve(
    "0193a1b2-7c00-7000-8000-0000000000b1",
    "0193a1b2-7c00-7000-8000-0000000000e1",
    {
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "mode": "test",
        "provider": "apple",
        "candidateHash": "example",
        "alone": False,
    },
)
print(result)
