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

	var body passbook.OrgsStageBrandAssetBody
	if err := json.Unmarshal([]byte(`{
  "slot": "logo",
  "png": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "x2": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.Orgs.StageBrandAsset(ctx, "0193a1b2-7c00-7000-8000-0000000000a1", &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
