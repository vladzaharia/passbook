import os
import httpx

res = httpx.post(
    "https://passbook.mobile/api/v1/webhook-endpoints/0193a1b2-7c00-7000-8000-0000000000e1/replay",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}"},
    json={
        "from": 1764000000000,
        "to": 1764003600000,
        "include": "failed",
        "dryRun": True,
    },
)
res.raise_for_status()
print(res.json())
