import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

for item in pb.template_imports.list(limit=20):
    print(item)
