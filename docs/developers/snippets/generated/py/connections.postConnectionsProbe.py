import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.connections.probe_config(
    {
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "connectorType": "http-json",
        "config": {
            "baseUrl": "https://api.northwind.example/v1",
            "auth": {
                "type": "bearer",
            },
            "list": {
                "path": "/customers",
                "query": [
                    {
                        "name": "limit",
                        "value": "2",
                    },
                ],
                "recordsPointer": "/data",
                "idPointer": "/id",
                "pagination": {
                    "style": "cursor",
                    "param": "starting_after",
                    "from": "last-id",
                    "hasMorePointer": "/has_more",
                },
            },
        },
        "secrets": {
            "token": "nw_live_••••3f9c",
        },
        "target": "list",
    },
)
print(result)
