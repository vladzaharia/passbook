package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

func main() {
	body := strings.NewReader(`{
  "action": "void",
  "ids": [
    "0193a1b2-7c00-7000-8000-0000000000e1"
  ]
}`)
	req, err := http.NewRequest("POST", "https://passbook.mobile/api/v1/passes/bulk", body)
	if err != nil {
		panic(err)
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv("PASSBOOK_KEY"))
	req.Header.Set("Idempotency-Key", fmt.Sprint(time.Now().UnixNano()))
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		panic(err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	fmt.Println(res.Status, string(out))
}
