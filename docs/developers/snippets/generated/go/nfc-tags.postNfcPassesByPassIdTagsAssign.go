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

	var body passbook.NfcTagsAssignBody
	if err := json.Unmarshal([]byte(`{
  "id": "0193a1b2-7c00-7000-8000-000000000082",
  "format": "hex",
  "binding": "pass",
  "label": "Wristband 14"
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.NFC.Tags.Assign(ctx, "0193a1b2-7c00-7000-8000-0000000000c1", &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
