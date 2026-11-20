import os
import httpx

res = httpx.post(
    "https://passbook.mobile/api/v1/templates/0193a1b2-7c00-7000-8000-0000000000b1/scan-setup",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}"},
    json={
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
    },
)
res.raise_for_status()
print(res.json())
