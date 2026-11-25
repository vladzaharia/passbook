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

	pager := pb.NFC.Tags.ListHistory(ctx, "0193a1b2-7c00-7000-8000-0000000000e1", nil)
	for pager.Next(ctx) {
		fmt.Printf("%+v\n", pager.Item())
	}
	if err := pager.Err(); err != nil {
		panic(err)
	}
}
