# @passbook/sdk

TypeScript client for the PassBook API. No runtime dependencies; uses `fetch`, so it runs on Node 20+, Cloudflare Workers, Deno, Bun and browsers.

```ts
import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY });

const pass = await pb.passes.create({
  templateId: '0193a1b2-7c00-7000-8000-0000000000b1',
  input: {
    eventName: 'Harbor Night',
    venueName: 'Harbor Hall',
    venueRegion: 'Cupertino, CA',
    startsAt: '2030-06-01T19:00:00-07:00',
    endsAt: '2030-06-01T22:00:00-07:00',
    attendee: 'Ada Example',
    ticketId: 'TICKET-0001',
  },
  holderEmail: 'ada@example.com',
});
```

Resources and methods are named as in the API reference: `pb.passes.create`, `pb.passes.retrieve`, `pb.passes.void`, `pb.passes.channels.update`, `pb.webhookEndpoints.rotateSecret`. Path parameters come first, then the body or query, then options.

## Test mode

A `pbp_test_` key only sees test data, and sandboxes never issue real passes. Develop with a test key; switch to a `pbp_live_` key when you ship. `pb.mode` reports which one the client holds.

## Options

```ts
new PassBook({
  apiKey,                    // required
  baseUrl: 'https://passbook.mobile',
  fetch,                     // your own fetch: a proxy, a test double, a service binding
  maxRetries: 2,
  timeoutMs: 60_000,         // per attempt
  // apiVersion: PassBook-Version; default: the newest version this SDK was generated against
});
```

Every method takes a final options argument: `idempotencyKey`, `signal`, `headers`, `maxRetries`, `timeoutMs`, and `query` (extra parameters, or the query of a call whose first argument is a body).

## Idempotency

Operations that accept an `Idempotency-Key` (such as `passes.create`) get a fresh UUID per call, reused on every retry, so a retry never creates a second pass. Pass your own to make a retry safe across processes:

```ts
await pb.passes.create(input, { idempotencyKey: `booking-${booking.id}` });
```

## Retries

The SDK retries 429, 5xx and network errors with exponential backoff and jitter, `maxRetries` times (default 2). It waits out `Retry-After` up to 60 seconds; a longer one is thrown as the error.

- A 429 is retried for every call: the request was refused before it ran.
- A 5xx or a network error is retried for `GET`, `PUT` and `DELETE`, and for `POST` and `PATCH` that carry an idempotency key. Other writes are not repeated, since the first may have run.

## Pagination

Lists that return `nextCursor` are async iterators over every item, and still a promise for the first page:

```ts
for await (const pass of pb.passes.list({ status: 'active' })) console.log(pass.id);

const page = await pb.passes.list({ limit: 25 });   // { items, nextCursor }
for await (const p of pb.passes.list().pages()) console.log(p.items.length);
```

## Errors

A non-2xx answer throws an `ApiError` subclass chosen by status: `BadRequestError` (400), `AuthenticationError` (401), `PermissionDeniedError` (403), `NotFoundError` (404), `ConflictError` (409), `ValidationError` (422), `RateLimitError` (429), `ServerError` (5xx). Each carries the problem fields.

```ts
try {
  await pb.passes.retrieve(id);
} catch (e) {
  if (e instanceof NotFoundError) console.log(e.code, e.requestId, e.docsUrl);
  else if (e instanceof ValidationError) console.log(e.issues);
  else throw e;
}
```

`code` is stable: branch on it, not on `detail`. `type` and `docsUrl` link to the error's page. A request that gets no answer throws `ConnectionError`.

## Webhooks

```ts
import { verifyWebhook } from '@passbook/sdk';

const event = await verifyWebhook(rawBody, request.headers, process.env.PASSBOOK_WEBHOOK_SECRET);
```

Pass the body exactly as received. The signature is HMAC-SHA256 over `<timestamp>.<body>` in `x-passbook-signature`; the timestamp must be within 300 seconds (`toleranceSeconds`). While a secret rotates the header carries one value per live secret and either secret verifies. Throws `WebhookSignatureError` with a `reason` of `missing_header`, `malformed`, `timestamp_out_of_range` or `mismatch`.

## Maintaining

The client is generated: `node tools/gen-sdk-ts.ts` (repository root) rewrites `src/generated` from `docs/api/openapi.v1.json` and `docs/api/sdk-names.json`; `--check` fails on drift. Build with `npm run build` here. Publishing is the owner's step.
