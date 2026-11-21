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
  "url": "https://hooks.example.com/passbook",
  "description": "Order system",
  "eventTypes": [
    "pass.issued",
    "pass.scanned"
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
