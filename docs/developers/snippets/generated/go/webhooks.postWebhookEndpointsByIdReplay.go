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
  "from": 1764000000000,
  "to": 1764003600000,
  "include": "failed",
  "dryRun": true
}`)
	req, err := http.NewRequest("POST", "https://passbook.mobile/api/v1/webhook-endpoints/0193a1b2-7c00-7000-8000-0000000000e1/replay", body)
	if err != nil {
		panic(err)
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv("PASSBOOK_KEY"))
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		panic(err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	fmt.Println(res.Status, string(out))
}
