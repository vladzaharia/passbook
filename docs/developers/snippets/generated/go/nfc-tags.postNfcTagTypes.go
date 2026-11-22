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

	var body passbook.NfcTagTypesCreateBody
	if err := json.Unmarshal([]byte(`{
  "name": "Ada Example",
  "use": "member",
  "scopes": "pass",
  "perPass": 1
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.NFC.TagTypes.Create(ctx, &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
