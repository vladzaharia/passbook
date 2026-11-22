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

	var body passbook.BlueprintsUseBody
	if err := json.Unmarshal([]byte(`{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "name": "Day pass",
  "version": {
    "passJson": {
      "formatVersion": 1,
      "passTypeIdentifier": "pass.mobile.passbook.northwind",
      "serialNumber": "0193a1b2-7c00-7000-8000-0000000000c2",
      "organizationName": "Northwind Climbing",
      "description": "Day pass",
      "backgroundColor": "rgb(17, 42, 74)",
      "foregroundColor": "rgb(255, 255, 255)",
      "labelColor": "rgb(255, 196, 0)",
      "generic": {
        "primaryFields": [
          {
            "key": "name",
            "label": "Guest",
            "value": "Ada Example"
          }
        ],
        "secondaryFields": [
          {
            "key": "tier",
            "label": "Pass",
            "value": "Day pass"
          }
        ],
        "auxiliaryFields": [
          {
            "key": "validUntil",
            "label": "Valid until",
            "value": "2026-12-31"
          }
        ]
      }
    },
    "manifest": {
      "tier": {}
    },
    "assets": [
      {
        "name": "logo.png",
        "sha1": "e6997603809dcf7d34d188068c529a7808556809"
      }
    ]
  },
  "baseVersion": "3"
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.Blueprints.Use(ctx, "baked:starter-event-ticket", &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
