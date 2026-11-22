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

	var body passbook.MessageRulesCountDueBody
	if err := json.Unmarshal([]byte(`{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "name": "Renewal reminder",
  "templateIds": [
    "0193a1b2-7c00-7000-8000-0000000000b1"
  ],
  "anchor": {
    "kind": "input",
    "input": "validUntil"
  },
  "offset": {
    "amount": 7,
    "unit": "day",
    "when": "before"
  },
  "yearly": false,
  "sendAt": "09:00",
  "timeZone": "America/Los_Angeles",
  "message": "Your membership renews in 7 days."
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.MessageRules.CountDue(ctx, &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
