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

	var body passbook.TerminalScansUndoBody
	if err := json.Unmarshal([]byte(`{
  "idempotencyKey": "0193a1b2-7c00-7000-8000-000000000f03"
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.Terminal.Scans.Undo(ctx, "0193a1b2-7c00-7000-8000-0000000000e1", &body, passbook.WithHeader("x-passbook-device", "door-1"))
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
