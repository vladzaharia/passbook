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

	var body passbook.BulkRunsStartBody
	if err := json.Unmarshal([]byte(`{
  "action": "remove",
  "message": "Your day pass was replaced by a monthly membership.",
  "selection": {
    "filter": {
      "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
      "status": "active"
    },
    "expectCount": 128
  }
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.BulkRuns.Start(ctx, &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
