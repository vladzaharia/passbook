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
  "keys": [
    "Example"
  ]
}`)
	req, err := http.NewRequest("POST", "https://passbook.mobile/api/v1/passes/photos/match", body)
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
