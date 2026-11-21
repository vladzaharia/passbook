import os
import httpx

res = httpx.post(
    "https://passbook.mobile/api/v1/roll-calls",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}"},
)
res.raise_for_status()
print(res.json())
