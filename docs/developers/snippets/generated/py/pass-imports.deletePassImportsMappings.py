import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.pass_imports.mappings.delete(
    template_id="0193a1b2-7c00-7000-8000-0000000000b1",
    name="Example",
)
print(result)
