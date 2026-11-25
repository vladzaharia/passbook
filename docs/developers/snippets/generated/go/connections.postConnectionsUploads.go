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
  "name": "members.csv",
  "content": "Holder email,Name,Tier,Valid until,Member ID\nada@example.com,Ada Example,Day pass,2026-12-31,NW-1001\ngrace@example.com,Grace Okafor,Day pass,2026-12-31,NW-1002\nalan@example.com,Alan Reyes,Day pass,2027-01-15,NW-1003\nmei@example.com,Mei Tanaka,Day pass,2026-12-31,NW-1004\nchris.example.com,Chris Dalton,Day pass,2026-12-31,NW-1005\n",
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
