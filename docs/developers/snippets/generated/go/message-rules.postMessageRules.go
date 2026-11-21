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
  "name": "Day-before reminder",
  "templateIds": [
    "0193a1b2-7c00-7000-8000-0000000000b1"
  ],
  "anchor": {
    "kind": "input",
    "input": "startsAt"
  },
  "offset": {
    "amount": 1,
    "unit": "day",
    "when": "before"
  },
  "timeZone": "Europe/Berlin",
  "message": "Tomorrow at 7 PM."
}`)
	req, err := http.NewRequest("POST", "https://passbook.mobile/api/v1/message-rules", body)
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
