package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
)

func main() {
	req, err := http.NewRequest("POST", "https://passbook.mobile/api/v1/connections/0193a1b2-7c00-7000-8000-0000000000e1/webhook-failures/0193a1b2-7c00-7000-8000-0000000000e1/resolve", nil)
	if err != nil {
		panic(err)
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv("PASSBOOK_KEY"))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		panic(err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	fmt.Println(res.Status, string(out))
}
