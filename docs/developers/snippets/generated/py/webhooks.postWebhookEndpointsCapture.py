import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.webhook_endpoints.ensure_capture(
    {
        "eventTypes": [
            "pass.issued",
            "pass.scanned",
        ],
    },
)
print(result)
