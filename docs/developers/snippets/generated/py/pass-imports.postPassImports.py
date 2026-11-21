import os
import httpx

res = httpx.post(
    "https://passbook.mobile/api/v1/pass-imports",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}"},
    json={
        "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
        "source": {
            "kind": "file",
            "name": "Example",
            "csv": "Example",
        },
    },
)
res.raise_for_status()
print(res.json())
