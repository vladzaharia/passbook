import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.connections.create(
    {
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "connectorType": "google-sheets",
        "name": "Booking sheet",
        "config": {
            "sheetId": "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms",
            "range": "Members!A:E",
        },
        "secrets": {
            "sheetsToken": "••••3f9c",
        },
        "webhookSecret": "whsec_demo571d4d450b1de2be7856efd7cafc",
        "mapping": {
            "name": {
                "from": "Name",
            },
            "tier": {
                "from": "Tier",
            },
            "validUntil": {
                "from": "Valid until",
            },
        },
    },
)
print(result)
