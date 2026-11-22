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

	var body passbook.PassImportsCheckBody
	if err := json.Unmarshal([]byte(`{
  "plan": {
    "mapping": {
      "eventName": {
        "from": "/Event"
      },
      "venueName": {
        "from": "/Venue"
      },
      "venueRegion": {
        "from": "/City"
      },
      "startsAt": {
        "from": "/Starts",
        "transform": {
          "kind": "date",
          "options": {
            "input": "iso",
            "output": "iso"
          }
        }
      },
      "endsAt": {
        "from": "/Ends",
        "transform": {
          "kind": "date",
          "options": {
            "input": "iso",
            "output": "iso"
          }
        }
      },
      "attendee": {
        "from": "/Attendee"
      },
      "ticketId": {
        "from": "/Ticket ID"
      }
    },
    "holderEmail": {
      "from": "/Holder email"
    },
    "externalId": {
      "from": "/Ticket ID"
    },
    "match": "externalId",
    "keepManual": false,
    "save": true,
    "overrides": {
      "3": {
        "/Starts": "2030-06-01T19:00:00-07:00"
      }
    }
  }
}`), &body); err != nil {
		panic(err)
	}

	result, err := pb.PassImports.Check(ctx, "0193a1b2-7c00-7000-8000-0000000000e1", &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
