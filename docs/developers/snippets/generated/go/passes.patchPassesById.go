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

	var body passbook.PassesUpdateBody
	if err := json.Unmarshal([]byte(`{
  "input": {
    "name": "Ada Example",
    "tier": "Day pass",
    "validUntil": "2027-01-31"
  },
  "notify": true
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.Passes.Update(ctx, "0193a1b2-7c00-7000-8000-0000000000c1", &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
