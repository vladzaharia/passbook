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

	var query passbook.PassImportsMappingsDeleteQuery
	if err := json.Unmarshal([]byte(`{
  "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
  "name": "Example"
}`), &query); err != nil {
		panic(err)
	}

	result, err := pb.PassImports.Mappings.Delete(ctx, &query)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
