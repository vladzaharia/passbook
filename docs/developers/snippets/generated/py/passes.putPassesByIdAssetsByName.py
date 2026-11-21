import os
import httpx

res = httpx.put(
    "https://passbook.mobile/api/v1/passes/0193a1b2-7c00-7000-8000-0000000000c1/assets/icon.png",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}", "Content-Type": "image/png"},
    content=open("image.png", "rb").read(),
)
res.raise_for_status()
print(res.json())
