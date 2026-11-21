import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

res = pb.templates.download_sample("0193a1b2-7c00-7000-8000-0000000000b1")
print(res.status_code)
