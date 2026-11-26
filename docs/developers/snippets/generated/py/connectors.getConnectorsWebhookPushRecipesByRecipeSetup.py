import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.connectors.recipe_setup.retrieve("shopify-orders")
print(result)
