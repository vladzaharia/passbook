import os
import httpx

res = httpx.post(
    "https://passbook.mobile/api/v1/visitors",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}"},
    json={
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "name": "Ada Example",
        "hostName": "Grace Host",
        "hostEmail": "grace@example.com",
        "windowFrom": 1764000000000,
        "windowUntil": 1764086400000,
    },
)
res.raise_for_status()
print(res.json())
