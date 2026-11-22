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

	var body passbook.ConnectionsUpdateBody
	if err := json.Unmarshal([]byte(`{
  "name": "Booking sheet",
  "config": {
    "sheetId": "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms",
    "range": "Members!A:E"
  },
  "secrets": {
    "sheetsToken": "ya29.fb90204b82135d002e703a9f596d0c121e293bc0"
  }
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.Connections.Update(ctx, "0193a1b2-7c00-7000-8000-0000000000e1", &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
