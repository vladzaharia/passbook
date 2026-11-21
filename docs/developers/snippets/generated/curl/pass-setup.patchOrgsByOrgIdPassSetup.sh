curl -X PATCH "https://passbook.mobile/api/v1/orgs/0193a1b2-7c00-7000-8000-0000000000a1/pass-setup" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
  "expectedRevision": "r1",
  "brand": {
    "logo": {
      "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    "passColors": {
      "background": "#0f172a",
      "foreground": "#ffffff",
      "label": "#fbbf24"
    }
  }
}'
