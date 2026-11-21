package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	passbook "github.com/vladzaharia/passbook/sdk/go"
)

func main() {
	ctx := context.Background()
	pb, err := passbook.NewClient(os.Getenv("PASSBOOK_KEY"))
	if err != nil {
		panic(err)
	}

	var body passbook.PassesCreateBody
	if err := json.Unmarshal([]byte(`{
  "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
  "input": {
    "eventName": "Harbor Night",
    "venueName": "Harbor Hall",
    "venueRegion": "Cupertino, CA",
    "startsAt": "2030-06-01T19:00:00-07:00",
    "endsAt": "2030-06-01T22:00:00-07:00",
    "attendee": "Ada Example",
    "ticketId": "TICKET-0001"
  },
  "holderEmail": "ada@example.com",
  "externalId": "booking_8841",
  "sendEmail": true
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.Passes.Create(ctx, &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
