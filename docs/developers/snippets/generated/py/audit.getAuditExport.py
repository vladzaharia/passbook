import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

res = pb.audit_entries.export()
print(res.status_code)
