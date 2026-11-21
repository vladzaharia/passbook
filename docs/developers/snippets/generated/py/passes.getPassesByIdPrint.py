import os
import httpx

res = httpx.get(
    "https://passbook.mobile/api/v1/passes/0193a1b2-7c00-7000-8000-0000000000c1/print",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}"},
)
res.raise_for_status()
print(res.status_code)
