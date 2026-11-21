import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.templates.releases.create(
    "0193a1b2-7c00-7000-8000-0000000000b1",
    {
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "mode": "test",
        "provider": "apple",
        "candidateId": "0193a1b2-7c00-7000-8000-0000000000e1",
        "approvalId": "0193a1b2-7c00-7000-8000-0000000000e1",
        "candidateHash": "Example",
        "expectedGeneration": 0,
    },
)
print(result)
