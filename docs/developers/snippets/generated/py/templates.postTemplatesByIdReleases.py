import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.templates.releases.create(
    "0193a1b2-7c00-7000-8000-0000000000b1",
    {
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "mode": "test",
        "provider": "apple",
        "candidateId": "0193a1b2-7c00-7000-8000-cc58496f0eab",
        "approvalId": "0193a1b2-7c00-7000-8000-4b53d9116a16",
        "candidateHash": "25a764cd27b2dece6d5111f0fdee90bba3c9490ac89039d9591a4c814f08bd85",
        "expectedGeneration": 3,
    },
)
print(result)
