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

	result, err := pb.WalletHealth.List(ctx, "0193a1b2-7c00-7000-8000-0000000000a1")
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
