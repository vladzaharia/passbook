import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

for item in pb.nfc.tags.list_for_pass("0193a1b2-7c00-7000-8000-0000000000c1"):
    print(item)
