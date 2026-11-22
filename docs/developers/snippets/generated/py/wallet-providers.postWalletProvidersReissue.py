import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.passes.reissue_provider_copies(
    {
        "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
        "provider": "google",
        "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
    },
)
print(result)
