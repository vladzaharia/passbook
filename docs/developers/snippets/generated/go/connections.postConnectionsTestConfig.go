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

	var body passbook.ConnectionsTestConfigBody
	if err := json.Unmarshal([]byte(`{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "connectorType": "google-sheets",
  "config": {
    "sheetId": "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms",
    "range": "Members!A:E"
  },
  "secrets": {
    "sheetsToken": "ya29.07b655bbd0c4f2a4a40f18285549a2a81d813168"
  },
  "mapping": {
    "name": {
      "from": "Name"
    },
    "tier": {
      "from": "Tier"
    },
    "validUntil": {
      "from": "Valid until"
    }
  },
  "voidWhen": [
    {
      "from": "Booking sheet",
      "op": "in",
      "values": [
        "Day pass"
      ]
    }
  ]
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.Connections.TestConfig(ctx, &body, nil)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
