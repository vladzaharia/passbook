curl -X POST "https://passbook.mobile/api/v1/scanning-sessions/setup" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "preset": "front_desk",
  "timeZone": "America/Los_Angeles",
  "places": [
    {
      "zoneId": "0193a1b2-7c00-7000-8000-000000000081"
    }
  ],
  "doors": [
    {
      "name": "Front desk",
      "place": "northwind",
      "admits": {
        "any": true
      },
      "hours": "always"
    }
  ]
}'
