import os

from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

result = pb.templates.preview(
    "0193a1b2-7c00-7000-8000-0000000000b1",
    {
        "input": {
            "eventName": "Friday Night Bouldering",
            "venueName": "Northwind Climbing",
            "venueRegion": "Seattle, WA",
            "startsAt": "2026-12-04T18:00:00-08:00",
            "endsAt": "2026-12-04T22:00:00-08:00",
            "attendee": "Ada Example",
            "ticketId": "NW-1001",
        },
    },
)
print(result)
