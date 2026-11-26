# @passbook/cli

```sh
export PASSBOOK_KEY=pbp_test_...
npx @passbook/cli listen --forward-to localhost:3000/hooks
npx @passbook/cli types <templateId> > passbook-types.ts
```

Needs Node 20+ and a `pbp_test_` key. `PASSBOOK_BASE_URL` overrides `https://passbook.mobile`.

## listen

Polls the sandbox's webhook captures and POSTs each new one to your server with its original body and headers, signature included, so your verification runs unchanged. No tunnel. It prints the signing secret to verify with, then one line per request.

| Flag | |
| --- | --- |
| `--forward-to <url>` | Required. `localhost:3000/hooks` or a full http(s) URL. |
| `--endpoint <id>` | A capture endpoint. Default: the sandbox's own, made if it has none. |
| `--interval <ms>` | Poll interval, at least 200. Default 2000. |
| `--from-start` | Also forward the captures already stored. |
| `--once` | Poll once and exit. |

## logs

`logs --follow` prints your Test calls as they arrive, oldest first: time, method, status, path, duration, error code, request id. It reads `GET /api/v1/request-logs` with `after=`, so the key needs the `logs:read` scope. Calls are kept 7 days.

| Flag | |
| --- | --- |
| `--follow` | Required. |
| `--status <4xx>` | A status class or one status. |
| `--code <CODE>` | An error code. |
| `--interval <ms>` | Poll interval, at least 200. Default 2000. |
| `--once` | Poll once and exit. |

## types

Prints `export type <Template>Input = {...}`, the type of a template's `input`, from `GET /templates/{id}/input-schema`. `--name` sets the type name; `--out <file>` writes a file.

```ts
import type { EventTicketInput } from './passbook-types.ts';

const input: EventTicketInput = { eventName: 'Harbor Night', /* ... */ };
await pb.passes.create({ templateId, input });
```

## passes

Issues or changes a pass. `ticket.json` holds the Quickstart ticket: `{"templateId": "0193a1b2-7c00-7000-8000-0000000000b1", "input": {"eventName": "Harbor Night", "venueName": "Harbor Hall", "venueRegion": "Cupertino, CA", "startsAt": "2030-06-01T19:00:00-07:00", "endsAt": "2030-06-01T22:00:00-07:00", "attendee": "Ada Example", "ticketId": "TICKET-0001"}}`. The key comes from PASSBOOK_KEY only. The body is a JSON object from `--file <path>`, or `--file -` for stdin; flags are laid over it. It prints the pass as JSON. A failure prints `CODE: detail` and exits 1.

    passbook passes create --file ticket.json --email ada@example.com
    cat pass.json | passbook passes create --file - --idempotency-key order-1042
    passbook passes update <passId> --set seat=B12 --notify

 Flag                      | Commands
---------------------------|---------------------------------------------
 --file <path\|->          | Both. JSON body; `-` reads stdin.
 --set key=value           | Both. Sets a field of `input`; repeatable.
 --external-id <id>        | Both.
 --idempotency-key <key>   | Both. Retrying with it never issues twice.
 --template <id>           | create. Required unless the body has `templateId`.
 --email, --serial         | create. Holder email, serial.
 --send-email              | create. Email the pass link.
 --template-version <v>    | update.
 --notify                  | update. Push the change to the holder's wallet.

## trigger

Sends a real Test event for a Test pass: `installed`, `uninstalled`, `scanned`, `scan_refused`, `push_failed`, `updated_on_device` or `email_failed`. Your webhook endpoints get it signed, with the `requestId` it prints. Without `--pass`, it uses the newest Test pass. `--device <id>` targets a device an earlier `installed` returned.

    passbook trigger installed
    passbook trigger uninstalled --pass <passId> --device <deviceId>

## Maintaining

`npm run build` here compiles to `dist`; it expects `@passbook/sdk` installed. Publishing is the owner's step.
