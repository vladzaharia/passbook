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

	var body passbook.WebhookEndpointsCreateBody
	if err := json.Unmarshal([]byte(`{
  "url": "https://bookings.northwind.example.com/hooks/passbook",
  "description": "Front-desk check-in sync",
  "eventTypes": [
    "pass.issued",
    "pass.scanned"
  ],
  "templateIds": [
    "0193a1b2-7c00-7000-8000-0000000000b1"
  ]
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.WebhookEndpoints.Create(ctx, &body, nil)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
