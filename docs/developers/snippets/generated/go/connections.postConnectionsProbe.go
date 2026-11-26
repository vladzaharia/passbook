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

	var body passbook.ConnectionsProbeConfigBody
	if err := json.Unmarshal([]byte(`{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "connectorType": "http-json",
  "config": {
    "baseUrl": "https://api.northwind.example/v1",
    "auth": {
      "type": "bearer"
    },
    "list": {
      "path": "/customers",
      "query": [
        {
          "name": "limit",
          "value": "2"
        }
      ],
      "recordsPointer": "/data",
      "idPointer": "/id",
      "pagination": {
        "style": "cursor",
        "param": "starting_after",
        "from": "last-id",
        "hasMorePointer": "/has_more"
      }
    }
  },
  "secrets": {
    "token": "nw_live_••••3f9c"
  },
  "target": "list"
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.Connections.ProbeConfig(ctx, &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
