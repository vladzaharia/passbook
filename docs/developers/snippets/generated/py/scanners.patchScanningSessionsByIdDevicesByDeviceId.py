import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.scanning_sessions.devices.update(
    "0193a1b2-7c00-7000-8000-0000000000e1",
    "0193a1b2-7c00-7000-8000-0000000000e1",
    {
        "name": "Day pass",
        "surface": "auto",
        "overrides": {
            "flow": "auto",
            "reader": "barcode",
        },
    },
)
print(result)
