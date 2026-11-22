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

	var body passbook.TemplatesCandidatesCreateBody
	if err := json.Unmarshal([]byte(`{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "mode": "test",
  "provider": "apple",
  "version": "3",
  "sourceReleaseId": "0193a1b2-7c00-7000-8000-942c94c71643",
  "projection": {}
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.Templates.Candidates.Create(ctx, "0193a1b2-7c00-7000-8000-0000000000b1", &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
