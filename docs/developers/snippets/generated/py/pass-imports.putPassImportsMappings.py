import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.pass_imports.mappings.save(
    {
        "name": "Day pass",
        "columns": [
            "tier",
        ],
        "plan": {
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
            "holderEmail": {
                "from": "Booking sheet",
                "transform": {
                    "kind": "enum",
                    "options": {
                        "tier": {},
                    },
                },
            },
            "externalId": {
                "from": "Booking sheet",
                "transform": {
                    "kind": "enum",
                    "options": {
                        "tier": {},
                    },
                },
            },
            "match": "externalId",
            "keepManual": False,
            "save": False,
        },
        "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
    },
)
print(result)
