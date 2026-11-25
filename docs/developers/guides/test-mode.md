---
id: test-mode
title: Test mode
line: Inbox, reset, purge
status: ready
---
Everything you run in the portal runs in test mode, in your sandbox. This page says what that means, how to look at what you made, and how to start over.

## What a sandbox does

- Every pass is a preview. Nothing is signed, added to a wallet, pushed or mailed.
- `downloadUrl` is the test preview page. It expires after 30 days, is hidden from search and has no Add button.
- Pass detail carries `testPreview: true`. `GET /p/<token>/pass.pkpass` answers `409` [SANDBOX_PREVIEW_ONLY](/developers/errors/SANDBOX_PREVIEW_ONLY).
- A sandbox never holds Live. A Live key or request is refused.
- Your plan is 500 test passes, 10 templates, 3 webhook endpoints and 3 keys. A create past a limit is `403` [SANDBOX_QUOTA](/developers/errors/SANDBOX_QUOTA) with `feature`, `limit` and `used`.
- Webhooks go to a capture endpoint that stores each signed request and sends nothing. [React to events](/developers/guides/react-to-events) uses it.
- In the browser, Try it signs requests with a 15-minute token tied to your session. A key sent from a browser is `403` [KEY_IN_BROWSER](/developers/errors/KEY_IN_BROWSER): keep keys on servers.

## Sandbox or Test mode

| | Developer sandbox | An organization's Test mode |
| --- | --- | --- |
| Passes | Previews no wallet can open | Signed, so a phone can add them |
| Live | Never | Test and Live, kept apart |
| Email | Test inbox | Test inbox |
| Limits | The plan above | The organization's plan |
| Start over | Reset, below | Delete the test passes |

## Check your key

{{run current-key}}

`mode` is `test`. `scopes` lists what the key may do.

## Read the test inbox

Email calls store the message instead of sending it. Set `PASS_ID` to the `id` of a pass of yours, send one, then list the inbox.

{{run send-pass-email}}

{{run read-test-inbox}}

Newest first. Open one to read it. Nothing reaches the recipient.

## See your calls

[Logs](/developers/logs) lists your key's calls for 7 days: method, path, status and `code`. Open one to see its redacted bodies for 24 hours.

## Start over

Reset and reopen are buttons in the [workbench](/developers). They need you signed in; no API key can call them.

- **Reset** deletes the sandbox's test passes, captured events, request log, test inbox, imports and idempotency records, restarts the quickstart and replaces your key. The old key stops when the reset starts. The sandbox and its Quickstart ticket template stay. You get 3 resets a day, then [SANDBOX_RESET_LIMIT](/developers/errors/SANDBOX_RESET_LIMIT).
- A sandbox closes after 90 days with no activity. A closed sandbox is read-only and its keys stop.
- **Reopen** brings a closed sandbox back with a new key, within 30 days of closing. After that it is purged and reopen is `409` [SANDBOX_REOPEN_WINDOW](/developers/errors/SANDBOX_REOPEN_WINDOW).

## Result

Within a few seconds the inbox lists your message to `ada@example.com`, and the pass has a preview page. After a reset your passes are gone and the old key answers `401`. Nothing was issued.
