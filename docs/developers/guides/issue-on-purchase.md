---
id: issue-on-purchase
title: Issue on purchase
line: Checkout webhook to pass
status: ready
---
You end with one pass for order 8841 and a handler that never makes a second one. Use the order id twice: as `externalId`, so you can find the pass later, and as the `Idempotency-Key`, so a retried webhook lands on the same pass.

Your sandbox renders the pass as a test preview. Nothing is signed or sent.

## Create the pass for an order

Send the order id as the key, not a random UUID: a retried webhook must send the same one. `templateId` is your Quickstart ticket template.

{{run create-order-pass}}

The answer is `201` with the pass. Set `PASS_ID` to its `id`; the later steps use it.

## Replay the order

Send the same request again. `-i` shows the headers.

{{run retry-create}}

The answer is the same pass, with the header `Idempotent-Replayed: true`. No second pass exists. The TypeScript tab makes both calls and prints `true`.

The same key with a different body is `422` [IDEMPOTENCY_KEY_REUSED](/developers/errors/IDEMPOTENCY_KEY_REUSED). A repeat while the first call still runs is `409` [IDEMPOTENCY_IN_PROGRESS](/developers/errors/IDEMPOTENCY_IN_PROGRESS); wait and send it again.

## Find the pass by order

{{run find-by-order}}

`items` holds the pass whose `externalId` matches. Look it up when a refund or a change arrives.

## Email it

Set `sendEmail` with `holderEmail` on create, or send it later.

{{run send-pass-email}}

A sandbox sends no mail. The message lands in the [test inbox](console:sandbox.getTestInbox).

## Result

The pass detail has `status: "active"` and `testPreview: true`, and `GET /passes?externalId=order-8841` lists one pass however often the webhook retried. Open `downloadUrl` from the create answer: it is the test preview page, the card as Apple, Google and Samsung would draw it, with no Add button.

Next: [update a pass](/developers/guides/update-a-pass) when the order changes.
