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
  "message": "The gym closes at 18:00 on 24 December.",
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "selection": {
    "filter": {
      "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
      "connectionId": "0193a1b2-7c00-7000-8000-000000000051"
    },
    "expectCount": 12
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
