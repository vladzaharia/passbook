import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.orgs.update_pass_setup(
    "0193a1b2-7c00-7000-8000-0000000000a1",
    {
        "expectedRevision": "4",
        "brand": {
            "accent": "#ffc400",
            "mark": "full",
        },
    },
)
print(result)
