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

	var body passbook.TemplatesReleasesCreateBody
	if err := json.Unmarshal([]byte(`{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "mode": "test",
  "provider": "apple",
  "candidateId": "0193a1b2-7c00-7000-8000-0000000000a2",
  "approvalId": "0193a1b2-7c00-7000-8000-0000000000a3",
  "candidateHash": "example",
  "expectedGeneration": 1
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.Templates.Releases.Create(ctx, "0193a1b2-7c00-7000-8000-0000000000b1", &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
