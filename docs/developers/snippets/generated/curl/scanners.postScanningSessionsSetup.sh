curl -X POST "https://passbook.mobile/api/v1/scanning-sessions/setup" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Idempotency-Key: qs-$(date +%s)-$RANDOM" \
  -H "Content-Type: application/json" \
  -d '{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "preset": "front_desk",
  "timeZone": "America/Los_Angeles",
  "doors": [
    {
      "name": "Front desk",
      "admits": {
        "any": true
      },
      "hours": "always"
    }
  ]
}'
