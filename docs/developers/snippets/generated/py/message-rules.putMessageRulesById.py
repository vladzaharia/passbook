import os
import httpx

res = httpx.put(
    "https://passbook.mobile/api/v1/message-rules/0193a1b2-7c00-7000-8000-0000000000e1",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}"},
    json={
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "name": "Example",
        "templateIds": [
            "0193a1b2-7c00-7000-8000-0000000000b1",
        ],
        "anchor": {
            "kind": "input",
            "input": "Example",
        },
        "offset": {
            "amount": 0,
            "unit": "day",
            "when": "before",
        },
        "timeZone": "Europe/Berlin",
        "message": "Example",
        "version": 1,
    },
)
res.raise_for_status()
print(res.json())
