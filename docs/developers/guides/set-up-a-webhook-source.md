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

## Result

The guide for your sender returns the steps and no secret. The same steps show in Connections, with a live check that waits for the first request.
