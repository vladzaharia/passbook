import os
import httpx

res = httpx.put(
    "https://passbook.mobile/api/v1/passes/0193a1b2-7c00-7000-8000-0000000000c1/member-photo",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}"},
    json={
        "png": "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR42mOQz3/9nxLMMGrAqAGjBgwXAwCBLngfV/beKAAAAABJRU5ErkJggg==",
    },
)
res.raise_for_status()
print(res.json())
