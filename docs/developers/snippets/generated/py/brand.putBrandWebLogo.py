import os
import httpx

res = httpx.put(
    "https://passbook.mobile/api/v1/brand/web-logo",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}"},
    json={
        "png": "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR42mOQz3/9nxLMMGrAqAGjBgwXAwCBLngfV/beKAAAAABJRU5ErkJggg==",
    },
)
res.raise_for_status()
print(res.json())
