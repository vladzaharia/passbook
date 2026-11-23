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

	var body passbook.NfcKeysetsImportTagsBody
	if err := json.Unmarshal([]byte(`{
  "csv": "uid,type,meta key,file key\n04A3B2C1D5E680,NTAG 424 DNA,00112233445566778899aabbccddeeff,ffeeddccbbaa99887766554433221100\n04A3B2C1D5E681,NTAG 424 DNA,00112233445566778899aabbccddee01,ffeeddccbbaa99887766554433221101\n04A3B2C1D5E682,NTAG 424 DNA,0123456789abcdef0123456789abcdef,ffeeddccbbaa99887766554433221102\n",
  "dryRun": true
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.NFC.Keysets.ImportTags(ctx, "0193a1b2-7c00-7000-8000-0000000000e1", &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
