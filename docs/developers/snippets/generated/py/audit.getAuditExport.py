import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

res = pb.audit_entries.export(from_=1794000000000)
print(res.status_code)
