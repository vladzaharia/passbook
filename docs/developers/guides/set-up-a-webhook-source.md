---
id: set-up-a-webhook-source
title: Set up a webhook source
line: Shopify, Stripe and more
status: ready
ops: connectors.getConnectorsWebhookPushRecipesByRecipeSetup, webhooks.getWebhookEndpointsSetup
---
Let another system tell PassBook when something happens, such as an order or a booking. You set up both sides: the sender's console and a connection in PassBook. In the admin, Connections walks you through it. These are the same steps.

## Read a sender's steps

The answer holds the steps for one sender, the events to pick and what to do when nothing arrives. It never holds a secret.

{{run webhook-setup-guide}}

## Steps for each sender

Pick the sender. Create the connection in PassBook first: it gives you the URL, and for some senders the secret. Labels at the sender change. Where a step says they may differ, trust the sender's own docs.

{{webhook-setup}}

## Sign a custom source

For a sender you write yourself, use the custom connection. Each request carries a timestamp and an HMAC signature made with the connection's secret. A valid request issues passes.

### Sign a request

Send a `POST` with a JSON body and two headers.

- `x-passbook-timestamp`: the current Unix time in seconds, 9 to 12 digits.
- `x-passbook-signature`: `v1=` and the lowercase hex HMAC-SHA256 of `{timestamp}.{raw body}`, keyed with the secret.

Sign the exact bytes you send. A changed space breaks the signature. The headers' names can be changed in the connection's Setup.

```sh
BODY='{"id":"evt-1","records":[{"ref":"m-001","record":{},"deleted":false}]}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$PASSBOOK_SECRET" -hex | sed 's/^.* //')
curl -X POST "$WEBHOOK_URL" \
  -H 'content-type: application/json' \
  -H "x-passbook-timestamp: $TS" \
  -H "x-passbook-signature: v1=$SIG" \
  -d "$BODY"
```

### Limits

- The timestamp may be at most 5 minutes behind PassBook's clock and 1 minute ahead. Otherwise the request fails as expired. Keep the sending clock in sync.
- A body is at most 256 KB. Send fewer records per request when it is larger.
- A request holds at most 100 records.

## Result

Connections also runs a live check that waits for the first request.
