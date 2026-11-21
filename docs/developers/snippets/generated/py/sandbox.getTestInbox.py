import os
import httpx

res = httpx.get(
    "https://passbook.mobile/api/v1/test-inbox?limit=25",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}"},
)
res.raise_for_status()
print(res.json())
