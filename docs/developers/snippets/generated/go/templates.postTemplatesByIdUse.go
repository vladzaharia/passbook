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

	var body passbook.BlueprintsUseBody
	if err := json.Unmarshal([]byte(`{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "name": "Quickstart ticket"
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.Blueprints.Use(ctx, "baked:starter-event-ticket", &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
