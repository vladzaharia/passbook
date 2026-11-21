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
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "connectorType": "Example",
  "name": "Example",
  "config": {}
}`)
	req, err := http.NewRequest("POST", "https://passbook.mobile/api/v1/connections", body)
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
