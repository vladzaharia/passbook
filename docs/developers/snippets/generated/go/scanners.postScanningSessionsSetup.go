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

	var body passbook.ScanningSessionsSetupBody
	if err := json.Unmarshal([]byte(`{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "preset": "venue",
  "doors": [
    {
      "name": "Main door",
      "admits": {
        "templateIds": [
          "0193a1b2-7c00-7000-8000-0000000000b1"
        ]
      }
    },
    {
      "name": "VIP door",
      "admits": {
        "templateIds": [
          "0193a1b2-7c00-7000-8000-0000000000b1"
        ]
      }
    }
  ]
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.ScanningSessions.Setup(ctx, &body, nil)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
