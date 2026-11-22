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

	var body passbook.TemplatesPreviewBody
	if err := json.Unmarshal([]byte(`{
  "version": "example",
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1"
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.Templates.Preview(ctx, "0193a1b2-7c00-7000-8000-0000000000b1", &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
