# SDK changes

## Unreleased

- `mode` reads `pbp_` and `pbo_` keys as well as `pb_`. The docs use `pbp_test_`.
- Every call sends `User-Agent: passbook-sdk-<lang>/<version>` (`passbook-cli/<version>` from the CLI) and `PassBook-Version`. The default version is the newest date in `docs/api/versions.json` when the SDK was generated; set `apiVersion` (`api_version` in Python, `WithAPIVersion` in Go) to pin another. `userAgent` overrides the User-Agent in the TypeScript SDK. A call that sets either header itself wins.
- Before this, an SDK sent no `PassBook-Version`, so it got the oldest behaviour (for example `POST /roll-calls` answered 200, not 201).
- Nested response types in the Go and Python SDKs are named `<Resource><Method>Response<Path>`, such as `BundlesCreateResponsePassesItem`. Every operation's answer is now a named schema, so the auto-named nested types of the old `…Result…` names are gone (Go 225, Python 285; none of them was documented). The top-level `<Resource><Method>Result` names stay as aliases. TypeScript is unchanged.
