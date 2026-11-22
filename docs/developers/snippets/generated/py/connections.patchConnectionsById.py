import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.connections.update(
    "0193a1b2-7c00-7000-8000-0000000000e1",
    {
        "name": "Day pass",
        "config": {
            "sheetId": "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms",
            "range": "Members!A:E",
        },
        "secrets": {
            "sheetsToken": "••••3f9c",
        },
    },
)
print(result)
