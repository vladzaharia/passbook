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

	var body passbook.ConnectionsCreateBody
	if err := json.Unmarshal([]byte(`{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "connectorType": "google-sheets",
  "name": "Booking sheet",
  "config": {
    "sheetId": "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms",
    "range": "Members!A:E"
  },
  "secrets": {
    "sheetsToken": "••••3f9c"
  },
  "webhookSecret": "whsec_demo571d4d450b1de2be7856efd7cafc",
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
  }
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.Connections.Create(ctx, &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
