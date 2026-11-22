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

	var body passbook.BrandUpdateBody
	if err := json.Unmarshal([]byte(`{
  "accent": "#ffc400",
  "mark": "full",
  "configRevision": 3
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.Brand.Update(ctx, &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
