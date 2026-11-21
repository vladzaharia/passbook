import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.passes.bulk_reissue(
    {
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
        "cause": "template_upgrade",
    },
)
print(result)
