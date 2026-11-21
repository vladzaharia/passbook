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

	var body passbook.WebhookEndpointsDeliveriesBulkReplayBody
	if err := json.Unmarshal([]byte(`{
  "from": 1764000000000,
  "to": 1764003600000,
  "include": "failed",
  "dryRun": true
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.WebhookEndpoints.Deliveries.BulkReplay(ctx, "0193a1b2-7c00-7000-8000-0000000000e1", &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
