import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

res = pb.passes.prints.download_asset("0193a1b2-7c00-7000-8000-0000000000c1", "icon.png")
print(res.status_code)
