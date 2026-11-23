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

	var body passbook.PassesBulkUpdateChannelsBody
	if err := json.Unmarshal([]byte(`{
  "action": "off",
  "channels": [
    "paper"
  ],
  "ids": [
    "0193a1b2-7c00-7000-8000-0000000000c1",
    "0193a1b2-7c00-7000-8000-f3f85c24ee38"
  ],
  "notify": false,
  "dryRun": false
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.Passes.BulkUpdateChannels(ctx, &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
