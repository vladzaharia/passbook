import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

for item in pb.templates.list_eligible(mode="test", provider="apple"):
    print(item)
