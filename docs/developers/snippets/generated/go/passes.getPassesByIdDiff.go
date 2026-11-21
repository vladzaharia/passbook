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

	var query passbook.PassesVersionsDiffQuery
	if err := json.Unmarshal([]byte(`{
  "from": 1,
  "to": 1
}`), &query); err != nil {
		panic(err)
	}

	result, err := pb.Passes.Versions.Diff(ctx, "0193a1b2-7c00-7000-8000-0000000000c1", &query)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
