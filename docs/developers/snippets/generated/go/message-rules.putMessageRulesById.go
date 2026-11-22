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
  "name": "Northwind Climbing",
  "templateIds": [
    "0193a1b2-7c00-7000-8000-0000000000b1"
  ],
  "match": [
    {
      "input": "tier",
      "values": [
        "Day pass"
      ]
    }
  ],
  "anchor": {
    "kind": "input",
    "input": "tier"
  },
  "offset": {
    "amount": 14,
    "unit": "day",
    "when": "before"
  },
  "yearly": false,
  "sendAt": "04:00",
  "timeZone": "America/Los_Angeles",
  "message": "The gym closes at 18:00 on 24 December.",
  "version": 3
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.MessageRules.Update(ctx, "0193a1b2-7c00-7000-8000-0000000000e1", &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
