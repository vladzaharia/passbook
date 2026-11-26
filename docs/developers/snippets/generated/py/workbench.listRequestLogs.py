import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

for item in pb.request_logs.list():
    print(item)
