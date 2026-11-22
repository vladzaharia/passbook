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
  "connectorType": "csv-url",
  "name": "Booking sheet",
  "config": {
    "url": "https://docs.google.com/spreadsheets/d/e/2PACX-northwind-bookings/pub?output=csv",
    "idColumn": "Booking ID"
  },
  "mapping": {
    "name": {
      "from": "/Name"
    },
    "tier": {
      "from": "/Plan"
    },
    "validUntil": {
      "from": "/Valid until"
    }
  },
  "defaultTemplateId": "0193a1b2-7c00-7000-8000-0000000000b1",
  "holderEmailField": "/Email",
  "mode": "poll"
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.Connections.Create(ctx, &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
