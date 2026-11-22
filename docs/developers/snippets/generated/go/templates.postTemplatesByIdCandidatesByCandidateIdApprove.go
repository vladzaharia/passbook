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

	var body passbook.TemplatesCandidatesApproveBody
	if err := json.Unmarshal([]byte(`{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "mode": "test",
  "provider": "apple",
  "candidateHash": "25a764cd27b2dece6d5111f0fdee90bba3c9490ac89039d9591a4c814f08bd85",
  "alone": false
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.Templates.Candidates.Approve(ctx, "0193a1b2-7c00-7000-8000-0000000000b1", "0193a1b2-7c00-7000-8000-0000000000e1", &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
