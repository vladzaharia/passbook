package main

import (
	"context"
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

	result, err := pb.WebhookEndpoints.Setup.Retrieve(ctx)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
