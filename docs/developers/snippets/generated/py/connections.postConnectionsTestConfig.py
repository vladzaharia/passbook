import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.connections.test_config(
    {
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "connectorType": "example",
        "config": {
            "example": {},
        },
        "secrets": {
            "example": "example",
        },
        "mapping": {
            "example": {
                "from": "example",
                "transform": {
                    "kind": "enum",
                    "options": {
                        "example": {},
                    },
                },
            },
        },
    },
)
print(result)
