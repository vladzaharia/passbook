# PassBook Go SDK

Go client for the PassBook API. Go 1.22+, standard library only.

```go
pb, err := passbook.NewClient(os.Getenv("PASSBOOK_KEY"))
if err != nil { ... }

pass, err := pb.Passes.Create(ctx, &passbook.PassesCreateBody{
	TemplateID: "0193a1b2-7c00-7000-8000-0000000000b1",
	Input: map[string]any{
		"eventName":   "Harbor Night",
		"venueName":   "Harbor Hall",
		"venueRegion": "Cupertino, CA",
		"startsAt":    "2030-06-01T19:00:00-07:00",
		"endsAt":      "2030-06-01T22:00:00-07:00",
		"attendee":    "Ada Example",
		"ticketId":    "TICKET-0001",
	},
})
```

Resources and methods are named as in the API reference: `pb.Passes.Create`, `pb.Passes.Channels.Update`, `pb.WebhookEndpoints.RotateSecret`. The arguments are the context, the path parameters, a pointer to the body, a pointer to the query, then options. Bodies and queries are always pointers, so `nil` leaves an optional one out. Responses are structs with the API's field names; an absent or null field is a pointer.

## Test mode

A `pbp_test_` key only sees test data, and sandboxes never issue real passes. `pb.Mode` is `"live"`, `"test"` or empty.

## Options

`NewClient(key, WithBaseURL(u), WithHTTPClient(h), WithMaxRetries(n), WithTimeout(d), WithRetryDelay(d), WithAPIVersion(v))`. `WithAPIVersion` sets `PassBook-Version`; default: the newest version this SDK was generated against. Per call: `WithIdempotencyKey`, `WithHeader`, `WithCallMaxRetries`, `WithCallTimeout`.

## Idempotency and retries

Operations that accept an `Idempotency-Key` get a random one per call, reused on every retry. Pass your own with `WithIdempotencyKey("booking-9")`. The SDK retries 429, 5xx and network errors with backoff and jitter and waits out `Retry-After` up to 60 seconds. A 429 is retried for every call; a 5xx or network error for GET, PUT and DELETE and for writes that carry a key.

## Pagination

A list returns a `*Pager`:

```go
pager := pb.Passes.List(ctx, &passbook.PassesListQuery{})
for pager.Next(ctx) {
	fmt.Println(pager.Item().ID)
}
if err := pager.Err(); err != nil { ... }
```

`All(ctx)` reads the rest into a slice.

## Errors

A non-2xx answer is a `*APIError` with `Status`, a stable `Code`, `RequestID`, `Issues` and `DocsURL()`:

```go
var apiErr *passbook.APIError
if errors.As(err, &apiErr) && apiErr.Code == "PASS_NOT_FOUND" { ... }
```

`*ConnectionError` means no answer came.

## Webhooks

```go
event, err := passbook.VerifyWebhook(rawBody, r.Header, os.Getenv("PASSBOOK_WEBHOOK_SECRET"))
```

Pass the body exactly as received. The timestamp must be within five minutes (`WithTolerance`). `WithSecrets` adds secrets for a receiver that rotates its own. A failure is a `*WebhookSignatureError` with `Reason` `missing_header`, `malformed`, `timestamp_out_of_range` or `mismatch`. `event.Decode(&passbook.PassUpdatedEvent{})` reads the event by its `Type`.

## Maintaining

`types_gen.go`, `resources_gen.go` and `ops_gen_test.go` are generated: `node tools/gen-sdk-go.ts` at the repository root rewrites them from `docs/api/openapi.v1.json` and `docs/api/sdk-names.json`, and `--check` fails on drift. Test with `go test ./...`. The module path assumes the repository is `github.com/vladzaharia/passbook`; publishing (a `sdk/go/v0.1.0` tag) is the owner's step.
