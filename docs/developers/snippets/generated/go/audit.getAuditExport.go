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

	res, err := pb.AuditEntries.Export(ctx, nil)
	if err != nil {
		panic(err)
	}
	defer res.Body.Close()
	fmt.Println(res.Status)
}
