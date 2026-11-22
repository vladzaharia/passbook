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

	var body passbook.OrgsUpdatePassSetupBody
	if err := json.Unmarshal([]byte(`{
  "expectedRevision": "4",
  "brand": {
    "name": "Day pass",
    "logo": {
      "sha": "d5d705ca576254bf7ea60c287f5c830178058ba455a678d68b7874cdff9a9d8e",
      "version": "b78bdcd5b6412c478d2a89e1c1296e3d617e3323c1c49c7d2c2bd73396dad792"
    }
  },
  "channels": {
    "mobile": "allowed",
    "apple": "allowed"
  }
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.Orgs.UpdatePassSetup(ctx, "0193a1b2-7c00-7000-8000-0000000000a1", &body, nil)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
