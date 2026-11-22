import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.pass_imports.check(
    "0193a1b2-7c00-7000-8000-0000000000e1",
    {
        "plan": {
            "mapping": {
                "name": {
                    "from": "/Name",
                },
                "tier": {
                    "from": "/Tier",
                },
                "validUntil": {
                    "from": "/Valid until",
                    "transform": {
                        "kind": "date",
                        "options": {
                            "input": "iso",
                            "output": "iso",
                        },
                    },
                },
            },
            "holderEmail": {
                "from": "/Holder email",
            },
            "externalId": {
                "from": "/Member ID",
            },
            "match": "externalId",
            "keepManual": False,
            "save": True,
            "overrides": {},
        },
    },
)
print(result)
