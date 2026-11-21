import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.pass_imports.mappings.save(
    {
        "templateId": "0197f1c2-6f3a-7b11-9c1e-2a5d4c8e9b10",
        "name": "Gym export",
        "columns": [
            "Member #",
            "Name",
            "Holder email",
        ],
        "plan": {
            "mapping": {
                "memberName": {
                    "from": "/Name",
                },
            },
            "holderEmail": {
                "from": "/Holder email",
            },
            "externalId": {
                "from": "/Member #",
            },
            "match": "externalId",
            "keepManual": False,
            "save": True,
        },
    },
)
print(result)
