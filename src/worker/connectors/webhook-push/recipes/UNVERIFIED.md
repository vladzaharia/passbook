# Unverified provider facts

Guide parts flagged `verified: false`. The UI shows them with "Labels may differ". A test reads the
keys in backticks: every flagged step (`<recipe>#<step id>`) and topic (`<recipe>#topic:<id>`) must be
listed here, and every key listed must still be flagged. Confirming one against a live account means
fixing the guide, removing its flag and its line here, and bumping the guide `version`.

Checked 2026-11-25 against the providers' docs. Owner-held: a Shopify dev store, a Stripe sandbox, a
WooCommerce test site, Ticket Tailor and Cal.com accounts.

## Flagged in the guides

### Shopify

- `shopify-orders#secret`: where the store signing secret shows. The "signed with" line is community-sourced.
- `shopify-orders#test`: what the Send test sample holds, and whether its `updated_at` is old.
- `shopify-orders#topic:orders/updated`: the UI label, and whether it covers payment, cancel and fulfil changes.
- `shopify-orders#topic:orders/paid`: the UI label.
- `shopify-orders#topic:orders/cancelled`: the UI label.
- `shopify-orders#topic:orders/fulfilled`: the UI label.
- `shopify-customers#secret`: as for orders.
- `shopify-customers#test`: as for orders.
- `shopify-customers#topic:customers/update`: the UI label.

### WooCommerce

- `woocommerce-orders#test`: the ping body format (`webhook_id=…`) and whether the ping is signed.

### Ticket Tailor

- `tickettailor-tickets#connect`: whether one webhook takes several events, plan limits, and whether HTTPS is required.
- `tickettailor-tickets#secret`: where the secret shows, and whether it is generated or set.
- `tickettailor-tickets#topic:ISSUED_TICKET.CREATED`: the event id casing on the wire.
- `tickettailor-tickets#topic:ISSUED_TICKET.UPDATED`: the event id casing on the wire.

### Cal.com

The official docs page did not load. Facts come from cal.com/features/webhooks and Hookdeck.

- `calcom-bookings#connect`: every field label, and the `no-secret-provided` header value.
- `calcom-bookings#test`: the ping payload shape, and whether the signature is plain hex or `sha256=`.
- `calcom-bookings#topic:BOOKING_CREATED`: the trigger label.
- `calcom-bookings#topic:BOOKING_RESCHEDULED`: the trigger label.
- `calcom-bookings#topic:BOOKING_CANCELLED`: the trigger label.
- `calcom-bookings#topic:BOOKING_REQUESTED`: the trigger label.
- `calcom-bookings#topic:BOOKING_REJECTED`: the trigger label.
- `calcom-bookings#topic:BOOKING_PAID`: the trigger label.

## Left out of the guides

These are unconfirmed and the guides do not state them.

- Stripe: the final create button label, whether the event picker shows ids or labels, whether the dashboard has a Send test event, `livemode: false` on sandbox events, any auto-disable policy.
- Shopify: whether a header marks test deliveries, and whether HTTPS is required.
- Ticket Tailor: the signature header key names (the parser expects `timestamp=` and `signature=`).
- WooCommerce: the API Version dropdown label ("WP REST API Integration v3", secondary source).
- Cal.com: retries for booking triggers.
