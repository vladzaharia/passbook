import os
import httpx

res = httpx.post(
    "https://passbook.mobile/api/v1/passes/photos/match",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}"},
    json={
        "keys": [
            "Example",
        ],
    },
)
res.raise_for_status()
print(res.json())
