curl -X POST "https://passbook.mobile/api/v1/scanning-sessions/setup" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "preset": "venue",
  "doors": [
    {
      "name": "Main door",
      "admits": {
        "templateIds": [
          "0193a1b2-7c00-7000-8000-0000000000b1"
        ]
      }
    }
  ]
}'
