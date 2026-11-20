---
id: test-mode
title: Test mode
line: Inbox, preview, limits
status: ready
---
Everything you run in the portal runs in test mode, in your sandbox. This page says what that means and how to look at what you made.

## What a sandbox does

- Every pass is a preview. Nothing is signed, added to a wallet, pushed or mailed.
- `downloadUrl` is the test preview page. It expires after 30 days, is hidden from search and has no Add button.
- Pass detail carries `testPreview: true`. `GET /p/<token>/pass.pkpass` answers `409 SANDBOX_PREVIEW_ONLY`.
- A sandbox never holds Live. A Live key or request is refused.
- Your plan is 500 test passes, 10 templates and 3 webhook endpoints. A create past a limit is `403 SANDBOX_QUOTA` with `feature`, `limit` and `used`.
- A sandbox with no activity for 90 days closes.

## Check your key

{{run current-key}}

`mode` is `test`. `scopes` lists what the key may do.

## Read the test inbox

Email calls store the message instead of sending it. Send one, then list the inbox.

{{run send-pass-email}}

[List the test inbox](console:sandbox.getTestInbox). Newest first; open one to read it. Nothing reaches the recipient.

## Start over

There is no reset call. Void and delete the passes you no longer want, or close the sandbox in the console: a closed sandbox is read-only, its keys stop working and it is not made again.

## Result

The inbox holds your message and the pass has a preview page. That is the whole path from call to result, with nothing issued.
