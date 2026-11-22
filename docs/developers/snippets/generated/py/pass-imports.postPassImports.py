import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.pass_imports.create(
    {
        "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
        "source": {
            "kind": "file",
            "name": "guests.csv",
            "csv": "Holder email,Event,Venue,City,Starts,Ends,Attendee,Ticket ID\nada@example.com,Harbor Night,Harbor Hall,\"Cupertino, CA\",2030-06-01T19:00:00-07:00,2030-06-01T22:00:00-07:00,Ada Example,TICKET-1001\ngrace@example.com,Harbor Night,Harbor Hall,\"Cupertino, CA\",TBD,2030-06-01T22:00:00-07:00,Grace Host,TICKET-1002\nalan@example.com,Harbor Night,Harbor Hall,\"Cupertino, CA\",2030-06-01T19:00:00-07:00,2030-06-01T22:00:00-07:00,Alan Guest,TICKET-1003",
        },
        "mapping": "auto",
    },
)
print(result)
