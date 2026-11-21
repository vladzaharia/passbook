import os
import httpx

res = httpx.post(
    "https://passbook.mobile/api/v1/scan/actions",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}", "x-passbook-device": "door-1"},
    json={
        "idempotencyKey": "0193a1b2-7c00-7000-8000-000000000f02",
        "input": {
            "code": "PB-4F7K-92QX",
            "method": "camera",
        },
        "clientTs": 1764000000000,
        "actionId": "auto",
    },
)
res.raise_for_status()
print(res.json())
