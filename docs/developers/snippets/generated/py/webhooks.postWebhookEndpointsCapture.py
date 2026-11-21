import os
import httpx

res = httpx.post(
    "https://passbook.mobile/api/v1/webhook-endpoints/capture",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}"},
    json={
        "eventTypes": [
            "pass.issued",
            "pass.updated",
        ],
    },
)
res.raise_for_status()
print(res.json())
