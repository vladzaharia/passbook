import os
import httpx

res = httpx.post(
    "https://passbook.mobile/api/v1/nfc/tag-types",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}"},
    json={
        "name": "Example",
        "use": "member",
    },
)
res.raise_for_status()
print(res.json())
