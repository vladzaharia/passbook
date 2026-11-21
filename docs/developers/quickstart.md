# Quickstart

Your first pass in five steps. About five minutes. The page is `/developers/quickstart`; every step runs in your own sandbox, and a sandbox never issues a real pass.

1. **Sign in.** A magic link or your identity provider.
2. **Create your sandbox.** One click. You get a test organization, the `Quickstart ticket` template released in Test, a capture endpoint for webhooks and a 30-day `pbp_test_` key. The key is shown once: copy it as `.env`.
3. **Run your first request.** `POST /api/v1/passes` with the template id and the ticket's fields. Expect `201`. The pass shows in Apple, Google, Samsung and paper under the TEST band, with a link and QR for the test preview page. Run again sends the same `Idempotency-Key`, so the same pass comes back.
4. **Change it live.** `PATCH /api/v1/passes/{id}` with `If-Match` set to the version you read and a new `admission`. The card changes; your capture endpoint receives `pass.updated`.
5. **Take it home.** Copy the `.env` (`PASSBOOK_KEY`, `PASSBOOK_TEMPLATE_ID`) and the request as a file.

## What the page shows

- **Your pass, live**: the four wallets, the test preview page and **What happened**: the request, the webhook your endpoint captured, the previews.
- **Waiting**: the request is in flight. After 30 seconds the page says it is taking longer and that Run again is safe.
- **Fail**: the problem's code and one sentence of fix. A sandbox with no test release or no template offers **Finish sandbox setup**, which runs the create call again and completes what is missing.
- **Done**: the buddy, and the time from your first view of the page to the pass being live.

## The funnel

Time to first pass is counted from the first quickstart view in this browser session (kept in `sessionStorage`) to the first pass in your sandbox. The page sends that time with sandbox create; the server clamps it to the last 24 hours. Each step also posts `{ "step": "view" | "sandbox" | "run" | "live" | "change" | "home" | "fail", "code"? }` to `/developers/beacon`. The server takes the organization from your session: no email, name, key, pass or template id is sent or stored. The `first_*` columns of the sandbox are set once, from what the database holds.

Platform admins read the totals at `GET /api/v1/metrics/platform/developer`: sandboxes by step, completion and the 50th and 90th percentile of time to first pass.
