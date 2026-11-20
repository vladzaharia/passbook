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
  "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
  "input": {
    "eventName": "Harbor Night",
    "venueName": "Harbor Hall",
    "venueRegion": "Cupertino, CA",
    "startsAt": "2030-06-01T19:00:00-07:00",
    "endsAt": "2030-06-01T22:00:00-07:00",
    "attendee": "Ada Example",
    "ticketId": "TICKET-0001"
  },
  "holderEmail": "ada@example.com",
  "externalId": "booking_8841",
  "sendEmail": true
}`)
	req, err := http.NewRequest("POST", "https://passbook.mobile/api/v1/passes", body)
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
