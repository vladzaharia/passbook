---
tags: runbook, sdk, release
---
# SDK Release Checks

Use before publishing an SDK. Publishing is the owner's and is not part of this note. The checks build and dry-run locally; nothing is published.

## Before you start

Bump `version` in the four manifests and the constants together; tests compare them:

- `sdk/typescript/src/version.ts`
- `CLI_VERSION` in `sdk/cli/src/cli.ts`
- `Version` in `sdk/go/core.go`
- `sdk/python/src/passbook/_version.py`

## 1. TypeScript SDK

Builds, then lists the pack contents. Expect only `dist`, README, LICENSE and package.json.

```sh name=sdk-ts confirm=no
npx tsc -p sdk/typescript/tsconfig.build.json && (cd sdk/typescript && npm pack --dry-run)
```

## 2. CLI

The CLI build resolves `@passbook/sdk` from node_modules, not from source paths, so link it first.

```sh name=sdk-cli confirm=no
(cd sdk/typescript && npm link) && (cd sdk/cli && npm link @passbook/sdk && npx tsc -p tsconfig.build.json && npm pack --dry-run)
```

## 3. Python

```sh name=sdk-python confirm=no
pip install build && (cd sdk/python && python -m build)
```

## 4. Go

```sh name=sdk-go confirm=no
(cd sdk/go && go vet ./... && go test ./...)
```
