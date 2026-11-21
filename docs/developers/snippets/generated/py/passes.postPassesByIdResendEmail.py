import os, uuid
import httpx

res = httpx.post(
    "https://passbook.mobile/api/v1/passes/0193a1b2-7c00-7000-8000-0000000000c1/resend-email",
    headers={"Authorization": f"Bearer {os.environ['PASSBOOK_KEY']}", "Idempotency-Key": str(uuid.uuid4())},
    json={
        "to": "ada@example.com",
        "attach": True,
    },
)
res.raise_for_status()
print(res.json())
