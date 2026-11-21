import os
import httpx

res = httpx.delete(
    "https://passbook.mobile/api/v1/brand/web-logo",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}"},
)
res.raise_for_status()
print(res.json())
