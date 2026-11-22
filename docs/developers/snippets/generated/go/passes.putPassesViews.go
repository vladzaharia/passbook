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

	var body passbook.PassViewsReplaceBody
	if err := json.Unmarshal([]byte(`{
  "items": [
    {
      "id": "expiring",
      "name": "Expiring this month",
      "filter": {
        "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
        "status": "active"
      }
    },
    {
      "id": "not-on-a-phone",
      "name": "Not on a phone yet",
      "filter": {
        "onDevice": false
      }
    }
  ],
  "revision": 2
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.PassViews.Replace(ctx, &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
