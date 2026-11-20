import os
import httpx

res = httpx.get(
    "https://passbook.mobile/api/v1/api-keys",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}"},
)
res.raise_for_status()
print(res.json())
