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

	var body passbook.PassImportsCreateBody
	if err := json.Unmarshal([]byte(`{
  "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
  "source": {
    "kind": "file",
    "name": "guests.csv",
    "csv": "Holder email,Event,Venue,City,Starts,Ends,Attendee,Ticket ID\nada@example.com,Harbor Night,Harbor Hall,\"Cupertino, CA\",2030-06-01T19:00:00-07:00,2030-06-01T22:00:00-07:00,Ada Example,TICKET-1001\ngrace@example.com,Harbor Night,Harbor Hall,\"Cupertino, CA\",TBD,2030-06-01T22:00:00-07:00,Grace Host,TICKET-1002\nalan@example.com,Harbor Night,Harbor Hall,\"Cupertino, CA\",2030-06-01T19:00:00-07:00,2030-06-01T22:00:00-07:00,Alan Guest,TICKET-1003"
  },
  "mapping": "auto"
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.PassImports.Create(ctx, &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
