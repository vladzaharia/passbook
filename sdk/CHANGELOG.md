# SDK changes

## Unreleased

- Removed: the `visitors` resource (TypeScript, Python and Go): `list`, `create`, `listHosts`, `checkOut`, `cancel` and `sendHostEmail`, with their types. The operations are gone from the API. Create a pass on a guest plan with `passes.create`, and sign someone out with the scan sign-out call.
- Nested response types in the Go and Python SDKs are named `<Resource><Method>Response<Path>`, such as `BundlesCreateResponsePassesItem`. Every operation's answer is now a named schema, so the auto-named nested types of the old `…Result…` names are gone (Go 225, Python 285; none of them was documented). The top-level `<Resource><Method>Result` names stay as aliases. TypeScript is unchanged.
