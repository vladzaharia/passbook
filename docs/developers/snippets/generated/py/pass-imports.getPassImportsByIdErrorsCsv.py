import os
import httpx

res = httpx.get(
    "https://passbook.mobile/api/v1/pass-imports/0193a1b2-7c00-7000-8000-0000000000e1/errors.csv",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}"},
)
res.raise_for_status()
print(res.status_code)
