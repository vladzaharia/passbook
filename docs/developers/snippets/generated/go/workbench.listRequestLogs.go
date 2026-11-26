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

	pager := pb.RequestLogs.List(ctx, nil)
	for pager.Next(ctx) {
		fmt.Printf("%+v\n", pager.Item())
	}
	if err := pager.Err(); err != nil {
		panic(err)
	}
}
