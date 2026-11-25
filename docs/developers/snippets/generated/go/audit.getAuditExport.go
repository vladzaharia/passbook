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

	var query passbook.AuditEntriesExportQuery
	if err := json.Unmarshal([]byte(`{
  "from": 1794000000000
}`), &query); err != nil {
		panic(err)
	}

	res, err := pb.AuditEntries.Export(ctx, &query)
	if err != nil {
		panic(err)
	}
	defer res.Body.Close()
	fmt.Println(res.Status)
}
