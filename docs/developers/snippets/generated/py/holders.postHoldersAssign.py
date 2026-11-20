import os
import httpx

res = httpx.post(
    "https://passbook.mobile/api/v1/holders/assign",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}"},
    json={
        "passId": "0193a1b2-7c00-7000-8000-0000000000c1",
        "email": "ada@example.com",
    },
)
res.raise_for_status()
print(res.json())
