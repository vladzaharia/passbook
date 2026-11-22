import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.scan_zones.update(
    "0193a1b2-7c00-7000-8000-0000000000e1",
    {
        "occupancy": "off",
        "capacity": 3,
        "maxStayMinutes": 15,
    },
)
print(result)
