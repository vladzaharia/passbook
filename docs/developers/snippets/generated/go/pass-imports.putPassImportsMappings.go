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

	var body passbook.PassImportsMappingsSaveBody
	if err := json.Unmarshal([]byte(`{
  "name": "Spring members",
  "columns": [
    "tier"
  ],
  "plan": {
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
    "holderEmail": {
      "from": "Booking sheet",
      "transform": {
        "kind": "enum",
        "options": {
          "tier": {}
        }
      }
    },
    "externalId": {
      "from": "Booking sheet",
      "transform": {
        "kind": "enum",
        "options": {
          "tier": {}
        }
      }
    },
    "match": "externalId",
    "keepManual": false,
    "save": false
  },
  "templateId": "0193a1b2-7c00-7000-8000-0000000000b1"
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.PassImports.Mappings.Save(ctx, &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
