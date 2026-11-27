# SDK changes

## Unreleased

- Added: `passbook login`, `logout` and `open` in the CLI (0.2.0). `login` uses a device code you type at `/workbench/cli` and keeps a 30-day `pbcli_test_` Test token per origin (keychain, else a 0600 file). `PASSBOOK_KEY` still wins. Keys carry `origin` (`app` or `cli`).
- Added: `pb.platform.*` for Platform keys (`pbo_` keys with `platform:*` scopes): `platform.settings` (`retrieve`, `update`) and `platform.walletRelease` (`retrieve`, `enableReady`) in TypeScript, `platform.wallet_release.enable_ready` in Python and `Platform.WalletRelease.EnableReady` in Go. `enableReady` sends a dry run; an apply is a person's and answers 403 `PERSON_REQUIRED`. The public developer portal does not list them.
- Removed: the `visitors` resource (TypeScript, Python and Go): `list`, `create`, `listHosts`, `checkOut`, `cancel` and `sendHostEmail`, with their types. The operations are gone from the API. Create a pass on a guest plan with `passes.create`, and sign someone out with the scan sign-out call.
- `mode` reads `pbp_` and `pbo_` keys as well as `pb_`. The docs use `pbp_test_`.
- Every call sends `User-Agent: passbook-sdk-<lang>/<version>` (`passbook-cli/<version>` from the CLI) and `PassBook-Version`. The default version is the newest date in `docs/api/versions.json` when the SDK was generated; set `apiVersion` (`api_version` in Python, `WithAPIVersion` in Go) to pin another. `userAgent` overrides the User-Agent in the TypeScript SDK. A call that sets either header itself wins.
- Before this, an SDK sent no `PassBook-Version`, so it got the oldest behaviour (for example `POST /roll-calls` answered 200, not 201).
- Nested response types in the Go and Python SDKs are named `<Resource><Method>Response<Path>`, such as `BundlesCreateResponsePassesItem`. Every operation's answer is now a named schema, so the auto-named nested types of the old `…Result…` names are gone (Go 225, Python 285; none of them was documented). The top-level `<Resource><Method>Result` names stay as aliases. TypeScript is unchanged.
