# Needs curl, jq and openssl. Set PASSBOOK_ENDPOINT_ID and PASSBOOK_CAPTURE_ID from the earlier answers.
capture=$(curl -s "https://passbook.mobile/api/v1/webhook-endpoints/$PASSBOOK_ENDPOINT_ID/captures/$PASSBOOK_CAPTURE_ID" \
  -H "Authorization: Bearer $PASSBOOK_KEY")
timestamp=$(jq -r '.headers["x-passbook-timestamp"]' <<<"$capture")
signature=$(jq -r '.headers["x-passbook-signature"]' <<<"$capture")
expected=$({ printf '%s.' "$timestamp"; jq -j .body <<<"$capture"; } \
  | openssl dgst -sha256 -hmac "$PASSBOOK_WEBHOOK_SECRET" | awk '{print $NF}')
case "$signature" in *"v1=$expected"*) echo verified ;; *) echo "no match" ;; esac
