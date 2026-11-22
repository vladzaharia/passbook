import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.scan_events.attach_scanners(
    "0193a1b2-7c00-7000-8000-0000000000e1",
    {
        "scannerIds": [
            "0193a1b2-7c00-7000-8000-000000000031",
        ],
    },
)
print(result)
