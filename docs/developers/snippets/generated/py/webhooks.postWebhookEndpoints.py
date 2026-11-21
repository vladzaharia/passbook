import os
import httpx

res = httpx.post(
    "https://passbook.mobile/api/v1/webhook-endpoints",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}"},
    json={
        "url": "https://hooks.example.com/passbook",
        "description": "Order system",
        "eventTypes": [
            "pass.issued",
            "pass.scanned",
        ],
    },
)
res.raise_for_status()
print(res.json())
