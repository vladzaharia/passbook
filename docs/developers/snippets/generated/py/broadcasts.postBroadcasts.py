import os
import httpx

res = httpx.post(
    "https://passbook.mobile/api/v1/broadcasts",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}"},
    json={
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "kind": "message",
        "name": "Doors open",
        "target": {
            "templateIds": [
                "0193a1b2-7c00-7000-8000-0000000000b1",
            ],
        },
        "patch": {
            "message": "Doors open at 6 PM.",
        },
        "send": "draft",
    },
)
res.raise_for_status()
print(res.json())
