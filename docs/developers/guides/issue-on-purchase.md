---
id: issue-on-purchase
title: Issue on purchase
line: Checkout webhook to pass
status: ready
---
When an order completes, make one pass for it. Use the order id twice: as `externalId`, so you can find the pass later, and as the `Idempotency-Key`, so a retried webhook never makes a second one.

Your sandbox renders the pass as a test preview. Nothing is signed or sent.

## Create the pass for an order

Send the order id as the key. In the console, the Idempotency-Key chip is on; set it to `order-8841`.

```json run=passes.postPasses
{
  "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
  "externalId": "order-8841",
  "holderEmail": "ada@example.com",
  "input": {
    "eventName": "Harbor Night",
    "venueName": "Harbor Hall",
    "venueRegion": "Cupertino, CA",
    "startsAt": "2030-06-01T19:00:00-07:00",
    "endsAt": "2030-06-01T22:00:00-07:00",
    "attendee": "Ada Example",
    "ticketId": "TICKET-8841"
  }
}
```

The answer is `201` with the pass. Keep its `id`.

## Replay the order

Choose "Run again with the same key". The answer carries the same pass and the header `Idempotent-Replayed: true`. No second pass exists.

The same key with a different body is `422 IDEMPOTENCY_KEY_REUSED`. A repeat while the first call still runs is `409 IDEMPOTENCY_IN_PROGRESS`; wait and send it again.

## Do it in code

{{show retry-create}}

Call this from your checkout webhook handler. A retry of the webhook lands on the same pass.

## Find the pass by order

{{run find-by-order}}

`items` holds the pass whose `externalId` matches. Filter on it when a refund or a change arrives.

## Email it

Set `sendEmail` with `holderEmail` on create, or send it later. Paste the pass `id` into the path.

{{run send-pass-email}}

A sandbox sends no mail. The message lands in the [test inbox](console:sandbox.getTestInbox).

## Result

Open `downloadUrl` from the create answer. It is the test preview page for the pass: the card as Apple, Google and Samsung would draw it, with no Add button. The pass detail carries `testPreview: true`.

Next: [update a pass](/developers/guides/update-a-pass) when the order changes.
