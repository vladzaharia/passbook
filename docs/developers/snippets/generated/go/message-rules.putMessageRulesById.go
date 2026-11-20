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

	var body passbook.MessageRulesUpdateBody
	if err := json.Unmarshal([]byte(`{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "name": "Example",
  "templateIds": [
    "0193a1b2-7c00-7000-8000-0000000000b1"
  ],
  "anchor": {
    "kind": "input",
    "input": "Example"
  },
  "offset": {
    "amount": 0,
    "unit": "day",
    "when": "before"
  },
  "timeZone": "Europe/Berlin",
  "message": "Example",
  "version": 1
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.MessageRules.Update(ctx, "0193a1b2-7c00-7000-8000-0000000000e1", &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
