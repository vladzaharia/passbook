import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.connections.test_config(
    {
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "connectorType": "google-sheets",
        "config": {
            "sheetId": "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms",
            "range": "Members!A:E",
        },
        "secrets": {
            "sheetsToken": "••••3f9c",
        },
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
        "voidWhen": [
            {
                "from": "Tier",
                "op": "in",
                "values": [
                    "Refunded",
                ],
            },
        ],
    },
)
print(result)
