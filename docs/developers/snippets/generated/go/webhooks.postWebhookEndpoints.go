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
  "url": "https://hooks.example.com/passbook",
  "description": "Order system",
  "eventTypes": [
    "pass.issued",
    "pass.scanned"
  ]
}`)
	req, err := http.NewRequest("POST", "https://passbook.mobile/api/v1/webhook-endpoints", body)
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
