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

	var body passbook.PassesMemberPhotoUploadBody
	if err := json.Unmarshal([]byte(`{
  "png": "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR42mOQz3/9nxLMMGrAqAGjBgwXAwCBLngfV/beKAAAAABJRU5ErkJggg=="
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.Passes.MemberPhoto.Upload(ctx, "0193a1b2-7c00-7000-8000-0000000000c1", &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
