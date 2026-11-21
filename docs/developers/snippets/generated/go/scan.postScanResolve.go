package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

func main() {
	body := strings.NewReader(`{
  "idempotencyKey": "0193a1b2-7c00-7000-8000-000000000f01",
  "input": {
    "code": "PB-4F7K-92QX",
    "method": "camera"
  },
  "clientTs": 1764000000000
}`)
	req, err := http.NewRequest("POST", "https://passbook.mobile/api/v1/scan/resolve", body)
	if err != nil {
		panic(err)
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv("PASSBOOK_KEY"))
	req.Header.Set("x-passbook-device", "door-1")
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		panic(err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	fmt.Println(res.Status, string(out))
}
