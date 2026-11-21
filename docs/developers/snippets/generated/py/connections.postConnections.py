import os
import httpx

res = httpx.post(
    "https://passbook.mobile/api/v1/connections",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}"},
    json={
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "connectorType": "Example",
        "name": "Example",
        "config": {},
    },
)
res.raise_for_status()
print(res.json())
