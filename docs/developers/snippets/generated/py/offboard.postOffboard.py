import os
import httpx

res = httpx.post(
    "https://passbook.mobile/api/v1/offboard",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}"},
    json={
        "holderEmail": "ada@example.com",
        "passes": "void",
        "dryRun": True,
    },
)
res.raise_for_status()
print(res.json())
