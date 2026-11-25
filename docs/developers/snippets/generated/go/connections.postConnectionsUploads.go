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

	var body passbook.ConnectionsUploadsCreateBody
	if err := json.Unmarshal([]byte(`{
  "name": "Example",
  "content": "Example",
  "encoding": "utf8"
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.Connections.Uploads.Create(ctx, &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
