# Quickstart

Your first pass in five steps. About five minutes. The page is `/workbench/quickstart`; every step runs in your own sandbox, and a sandbox never issues a real pass.

1. **Sign in.** Polaris ID, with your passkey.
2. **Sandbox.** One click. You get a test organization, the `Quickstart ticket` template released in Test, a capture endpoint for webhooks and a 30-day `pbp_test_` key. The key is shown once in a `.env` box; **Copy .env** copies it and hides it as `pbp_test_…amDQ`. Lost it? Roll it in Keys.
3. **First call.** `POST /api/v1/passes` with the template id and the ticket's fields, from your terminal (curl is the default) or **Run here**. The page listens for a call from any key of the sandbox and draws the pass when it arrives, stamped with your tool (`curl/8.7.1`). A `422` marks the field to add. The pass shows in Apple, Google, Samsung and paper under the TEST band, with a link and QR for the test preview page.
4. **Change it.** `PATCH /api/v1/passes/{id}` with `If-Match` set to the version you read and a new `admission`. The card changes; the response carries the new `ETag`.
5. **Hear back.** The events your capture endpoint stored, signed and never sent. **Send test event** adds one.

Progress comes from the server, so a reload shows the same page; only the key reveal is gone. The run clock sits in the header chip until the last step lands. **Reset** in the workbench deletes the sandbox's test passes, captured events and request log, restarts the track and replaces the key.

## What the page shows

- **Your pass, live**: the four wallets, the test preview page and **What happened**: the request, the webhook your endpoint captured, the previews.
- **Listening**: a pulse while the page waits for your terminal. After ten quiet minutes it says how to check the key and offers **Listen again**.
- **Fail**: the problem's code and one sentence of fix. A sandbox with no test release or no template offers **Finish sandbox setup**, which runs the create call again and completes what is missing.
- **Done**: the buddy, the time from your first view of the page to the last step, **Copy .env** and your workbench.

## The funnel

Time to first pass is counted from the first quickstart view in this browser session (kept in `sessionStorage`) to the first pass in your sandbox. The page sends that time with sandbox create; the server clamps it to the last 24 hours. Each step also posts `{ "step": "view" | "sandbox" | "run" | "live" | "change" | "home" | "fail", "code"? }` to `/developers/beacon`. The server takes the organization from your session: no email, name, key, pass or template id is sent or stored. The `first_*` columns of the sandbox are set once, from what the database holds.

Platform admins read the totals at `GET /api/v1/metrics/platform/developer`: sandboxes by step, completion and the 50th and 90th percentile of time to first pass.
