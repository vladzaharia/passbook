import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

for item in pb.connections.webhook_arrivals.list("0193a1b2-7c00-7000-8000-0000000000e1", limit=25):
    print(item)
