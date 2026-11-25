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

	var query passbook.AuditEntriesListQuery
	if err := json.Unmarshal([]byte(`{
  "from": 1794000000000,
  "limit": 25
}`), &query); err != nil {
		panic(err)
	}

	pager := pb.AuditEntries.List(ctx, &query)
	for pager.Next(ctx) {
		fmt.Printf("%+v\n", pager.Item())
	}
	if err := pager.Err(); err != nil {
		panic(err)
	}
}
