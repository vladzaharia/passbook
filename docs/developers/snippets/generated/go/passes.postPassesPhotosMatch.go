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

	var body passbook.PassesMatchPhotosBody
	if err := json.Unmarshal([]byte(`{
  "keys": [
    "NW-1001",
    "NW-1002"
  ]
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.Passes.MatchPhotos(ctx, &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
