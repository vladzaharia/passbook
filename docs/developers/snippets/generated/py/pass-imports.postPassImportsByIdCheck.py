import os
import httpx

res = httpx.post(
    "https://passbook.mobile/api/v1/pass-imports/0193a1b2-7c00-7000-8000-0000000000e1/check",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}"},
    json={
        "plan": {
            "mapping": {},
            "holderEmail": {
                "from": "Example",
            },
            "externalId": {
                "from": "Example",
            },
            "match": "externalId",
        },
    },
)
res.raise_for_status()
print(res.json())
