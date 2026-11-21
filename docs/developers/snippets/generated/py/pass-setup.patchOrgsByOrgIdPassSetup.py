import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.orgs.update_pass_setup(
    "0193a1b2-7c00-7000-8000-0000000000a1",
    {
        "expectedRevision": "r1",
        "brand": {
            "logo": {
                "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
            "passColors": {
                "background": "#0f172a",
                "foreground": "#ffffff",
                "label": "#fbbf24",
            },
        },
    },
)
print(result)
