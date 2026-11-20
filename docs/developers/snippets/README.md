# Snippets

- `guides/`: hand-written, one `.ts` (and a `.sh` where one request tells the story) per task. `index.json` lists each with its guide and the operations it calls.
- `generated/<lang>/<operationId>`: every operation a key may call, in `curl`, `ts`, `py` and `go`. Written by `node tools/gen-snippets.ts`; never edit. The reference pages show the same text.

## Change one

- A generated sample is wrong: fix the contract example, or add `snippet` (`request`, `query`, `headers`) for the operation in `docs/api/reference/snippets.json`, then run the generator. `check:rules` fails on a stale file.
- A guide snippet: edit the file. `test/developers/snippets.test.ts` runs every TypeScript and curl snippet against `createApp()` with a test key; `tools/gen-snippets.test.ts` typechecks them against `@passbook/sdk`.
- Add a guide snippet: write the file, add a row to `guides/index.json`. Use the example ids from `src/web/developers/model/ids.ts`; a signed-in reader sees their own.

## Rules

- The key is `$PASSBOOK_KEY` or `process.env.PASSBOOK_KEY`, never a value.
- TypeScript uses `@passbook/sdk`. Python and Go use `httpx` and `net/http` until their SDKs ship.
- A comment only where a step is not obvious.
