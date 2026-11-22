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
      "id": "0193a1b2-7c00-7000-8000-0000000000c1",
      "name": "Day pass",
      "filter": {
        "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
        "connectionId": "0193a1b2-7c00-7000-8000-000000000051"
      }
    }
  ],
  "revision": 3,
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1"
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.PassViews.Replace(ctx, &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
