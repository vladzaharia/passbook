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

	var body passbook.PassesBulkApplyBody
	if err := json.Unmarshal([]byte(`{
  "action": "void",
  "message": "The gym closes at 18:00 on 24 December.",
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "ids": [
    "0193a1b2-7c00-7000-8000-8b1bb892d676"
  ]
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.Passes.BulkApply(ctx, &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
