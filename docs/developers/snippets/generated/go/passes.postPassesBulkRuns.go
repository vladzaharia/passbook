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
  "action": "void",
  "selection": {
    "filter": {
      "status": "active"
    },
    "expectCount": 442
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
