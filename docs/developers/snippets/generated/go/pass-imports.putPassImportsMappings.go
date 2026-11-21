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
  "templateId": "0197f1c2-6f3a-7b11-9c1e-2a5d4c8e9b10",
  "name": "Gym export",
  "columns": [
    "Member #",
    "Name",
    "Holder email"
  ],
  "plan": {
    "mapping": {
      "memberName": {
        "from": "/Name"
      }
    },
    "holderEmail": {
      "from": "/Holder email"
    },
    "externalId": {
      "from": "/Member #"
    },
    "match": "externalId",
    "keepManual": false,
    "save": true
  }
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.PassImports.Mappings.Save(ctx, &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
