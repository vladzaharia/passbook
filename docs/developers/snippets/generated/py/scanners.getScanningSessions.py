import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

for item in pb.scanning_sessions.list(limit=25):
    print(item)
