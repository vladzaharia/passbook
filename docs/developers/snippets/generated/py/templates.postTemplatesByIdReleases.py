import os
import httpx

res = httpx.post(
    "https://passbook.mobile/api/v1/templates/0193a1b2-7c00-7000-8000-0000000000b1/releases",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}"},
    json={
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "mode": "test",
        "provider": "apple",
        "candidateId": "0193a1b2-7c00-7000-8000-0000000000e1",
        "approvalId": "0193a1b2-7c00-7000-8000-0000000000e1",
        "candidateHash": "Example",
        "expectedGeneration": 0,
    },
)
res.raise_for_status()
print(res.json())
