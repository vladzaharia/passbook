import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.connections.test_config(
    {
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "connectorType": "csv-url",
        "config": {
            "url": "https://docs.google.com/spreadsheets/d/e/2PACX-northwind-bookings/pub?output=csv",
            "idColumn": "Booking ID",
        },
        "mapping": {
            "name": {
                "from": "/Name",
            },
            "tier": {
                "from": "/Plan",
            },
            "validUntil": {
                "from": "/Valid until",
            },
        },
    },
)
print(result)
