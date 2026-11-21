import os
import httpx

res = httpx.get(
    "https://passbook.mobile/api/v1/visitors?dayStart=1764000000000&dayEnd=1764086400000",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}"},
)
res.raise_for_status()
print(res.json())
