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

	var body passbook.PassImportsCheckBody
	if err := json.Unmarshal([]byte(`{
  "plan": {
    "mapping": {
      "name": {
        "from": "/Name"
      },
      "tier": {
        "from": "/Tier"
      },
      "validUntil": {
        "from": "/Valid until",
        "transform": {
          "kind": "date",
          "options": {
            "input": "iso",
            "output": "iso"
          }
        }
      }
    },
    "holderEmail": {
      "from": "/Holder email"
    },
    "externalId": {
      "from": "/Member ID"
    },
    "match": "externalId",
    "keepManual": false,
    "save": true,
    "overrides": {}
  }
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.PassImports.Check(ctx, "0193a1b2-7c00-7000-8000-0000000000e1", &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
