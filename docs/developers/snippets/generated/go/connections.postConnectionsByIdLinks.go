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

	var body passbook.ConnectionsLinksCreateBody
	if err := json.Unmarshal([]byte(`{
  "objectType": "invoice",
  "externalId": "booking_8841",
  "localId": "0193a1b2-7c00-7000-8000-0059709b2a3c"
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.Connections.Links.Create(ctx, "0193a1b2-7c00-7000-8000-0000000000e1", &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
