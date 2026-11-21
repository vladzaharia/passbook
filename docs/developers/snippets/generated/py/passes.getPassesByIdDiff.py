import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.passes.versions.diff("0193a1b2-7c00-7000-8000-0000000000c1", from_=1, to=1)
print(result)
