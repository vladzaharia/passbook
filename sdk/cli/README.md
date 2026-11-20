# @passbook/cli

```sh
export PASSBOOK_KEY=pb_test_...
npx @passbook/cli listen --forward-to localhost:3000/hooks
npx @passbook/cli types <templateId> > passbook-types.ts
```

Needs Node 20+ and a `pb_test_` key. `PASSBOOK_BASE_URL` overrides `https://passbook.mobile`.

## listen

Polls the sandbox's webhook captures and POSTs each new one to your server with its original body and headers, signature included, so your verification runs unchanged. No tunnel. It prints the signing secret to verify with, then one line per request.

| Flag | |
| --- | --- |
| `--forward-to <url>` | Required. `localhost:3000/hooks` or a full http(s) URL. |
| `--endpoint <id>` | A capture endpoint. Default: the sandbox's own, made if it has none. |
| `--interval <ms>` | Poll interval, at least 200. Default 2000. |
| `--from-start` | Also forward the captures already stored. |
| `--once` | Poll once and exit. |

## types

Prints `export type <Template>Input = {...}`, the type of a template's `input`, from `GET /templates/{id}/input-schema`. `--name` sets the type name; `--out <file>` writes a file.

```ts
import type { EventTicketInput } from './passbook-types.ts';

const input: EventTicketInput = { eventName: 'Harbor Night', /* ... */ };
await pb.passes.create({ templateId, input });
```

## Maintaining

`npm run build` here compiles to `dist`; it expects `@passbook/sdk` installed. Publishing is the owner's step.
