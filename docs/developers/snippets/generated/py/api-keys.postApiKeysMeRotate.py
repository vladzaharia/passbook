import os
import httpx

res = httpx.post(
    "https://passbook.mobile/api/v1/api-keys/me/rotate",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}"},
    json={
        "overlapHours": 24,
    },
)
res.raise_for_status()
print(res.json())
