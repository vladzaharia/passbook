package passbook

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	mrand "math/rand"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Version is this SDK's version, sent in the User-Agent. Keep equal to the module tag.
const Version = "0.1.0"

const maxRetryAfter = 60 * time.Second
const maxBackoff = 8 * time.Second

// RequestOption changes one call.
type RequestOption func(*callOptions)

type callOptions struct {
	idempotencyKey string
	header         http.Header
	maxRetries     *int
	timeout        *time.Duration
}

// WithIdempotencyKey sends the key as Idempotency-Key on operations that accept one. Default: a fresh
// random key per call, reused on every retry.
func WithIdempotencyKey(key string) RequestOption {
	return func(o *callOptions) { o.idempotencyKey = key }
}

// WithHeader adds a header to this call.
func WithHeader(name, value string) RequestOption {
	return func(o *callOptions) {
		if o.header == nil {
			o.header = http.Header{}
		}
		o.header.Set(name, value)
	}
}

// WithCallMaxRetries overrides the client's retries for this call.
func WithCallMaxRetries(n int) RequestOption { return func(o *callOptions) { o.maxRetries = &n } }

// WithCallTimeout overrides the client's per-attempt timeout for this call.
func WithCallTimeout(d time.Duration) RequestOption { return func(o *callOptions) { o.timeout = &d } }

// call is one operation, as the generated resources describe it.
type call struct {
	method string
	path   string
	query  url.Values
	body   any
	// raw is a binary body sent as is with contentType.
	raw         []byte
	contentType string
	idempotent  bool
}

type core struct {
	apiKey     string
	baseURL    string
	http       *http.Client
	maxRetries int
	timeout    time.Duration
	retryDelay time.Duration
	apiVersion string
	sleep      func(context.Context, time.Duration) error
}

func sleepContext(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// pathEscape makes one path parameter safe to put in a path.
func pathEscape(v any) string { return url.PathEscape(fmt.Sprint(v)) }

// queryValues turns a query struct into URL parameters through its JSON tags; nil fields are skipped.
func queryValues(q any) url.Values {
	out := url.Values{}
	if q == nil {
		return out
	}
	data, err := json.Marshal(q)
	if err != nil || string(data) == "null" {
		return out
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var fields map[string]any
	if dec.Decode(&fields) != nil {
		return out
	}
	for name, v := range fields {
		if list, ok := v.([]any); ok {
			for _, item := range list {
				out.Add(name, fmt.Sprint(item))
			}
		} else if v != nil {
			out.Add(name, fmt.Sprint(v))
		}
	}
	return out
}

func newKey() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func retryAfter(header string, now time.Time) (time.Duration, bool) {
	header = strings.TrimSpace(header)
	if header == "" {
		return 0, false
	}
	if s, err := strconv.ParseFloat(header, 64); err == nil || errors.Is(err, strconv.ErrRange) {
		// Too long to wait is reported as just over the limit; converting a huge or infinite value overflows.
		if math.IsNaN(s) {
			return 0, true
		}
		if s > maxRetryAfter.Seconds() {
			return maxRetryAfter + time.Second, true
		}
		return time.Duration(math.Max(0, s) * float64(time.Second)), true
	}
	if t, err := http.ParseTime(header); err == nil {
		return max(0, t.Sub(now)), true
	}
	return 0, false
}

func backoff(attempt int, base time.Duration, jitter float64) time.Duration {
	d := time.Duration(float64(base) * math.Pow(2, float64(attempt)))
	return time.Duration(float64(min(d, maxBackoff)) * (0.5 + jitter/2))
}

// cancelBody releases the attempt's timeout when the caller closes a download.
type cancelBody struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (b cancelBody) Close() error {
	defer b.cancel()
	return b.ReadCloser.Close()
}

// send makes the call with retries and returns the 2xx response, its body open.
func (c *core) send(ctx context.Context, cl call, opts []RequestOption) (*http.Response, error) {
	var o callOptions
	for _, f := range opts {
		f(&o)
	}
	var body []byte
	contentType := ""
	switch {
	case cl.raw != nil:
		body, contentType = cl.raw, cl.contentType
	case cl.body != nil:
		data, err := json.Marshal(cl.body)
		if err != nil {
			return nil, fmt.Errorf("passbook: could not encode the request body: %w", err)
		}
		if string(data) != "null" {
			body, contentType = data, "application/json"
		}
	}
	key := ""
	if cl.idempotent {
		if key = o.idempotencyKey; key == "" {
			key = newKey()
		}
	}
	// Safe to repeat after a lost response (RFC 9110); POST and PATCH are, only with an idempotency key.
	repeatable := cl.method == "GET" || cl.method == "PUT" || cl.method == "DELETE" || key != ""
	retries, timeout := c.maxRetries, c.timeout
	if o.maxRetries != nil {
		retries = *o.maxRetries
	}
	if o.timeout != nil {
		timeout = *o.timeout
	}
	target := c.baseURL + cl.path
	if len(cl.query) > 0 {
		target += "?" + cl.query.Encode()
	}

	for attempt := 0; ; attempt++ {
		attemptCtx, cancel := context.WithTimeout(ctx, timeout)
		req, err := http.NewRequestWithContext(attemptCtx, cl.method, target, bytes.NewReader(body))
		if err != nil {
			cancel()
			return nil, err
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", "passbook-sdk-go/"+Version)
		req.Header.Set("PassBook-Version", c.apiVersion)
		for name, values := range o.header {
			req.Header[name] = values
		}
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		if key != "" {
			req.Header.Set("Idempotency-Key", key)
		}
		res, err := c.http.Do(req)
		if err != nil {
			cancel()
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if !repeatable || attempt >= retries {
				return nil, &ConnectionError{Err: err}
			}
			if err := c.sleep(ctx, backoff(attempt, c.retryDelay, mrand.Float64())); err != nil {
				return nil, err
			}
			continue
		}
		if res.StatusCode >= 200 && res.StatusCode < 300 {
			res.Body = cancelBody{res.Body, cancel}
			return res, nil
		}
		text, _ := io.ReadAll(res.Body)
		res.Body.Close()
		cancel()
		apiErr := apiErrorFrom(res.StatusCode, text, res.Header)
		// A 429 was refused before it ran, so any call may repeat; a 5xx may have run.
		retryable := res.StatusCode == 429 || (res.StatusCode >= 500 && repeatable)
		asked, hasAsked := retryAfter(res.Header.Get("Retry-After"), time.Now())
		if !retryable || attempt >= retries || (hasAsked && asked > maxRetryAfter) {
			return nil, apiErr
		}
		wait := backoff(attempt, c.retryDelay, mrand.Float64())
		if hasAsked {
			wait = asked
		}
		if err := c.sleep(ctx, wait); err != nil {
			return nil, err
		}
	}
}

// do makes the call and decodes a JSON answer into out; out is nil for no content.
func (c *core) do(ctx context.Context, cl call, out any, opts []RequestOption) error {
	res, err := c.send(ctx, cl, opts)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return &ConnectionError{Err: err}
	}
	if out == nil || res.StatusCode == http.StatusNoContent || len(bytes.TrimSpace(data)) == 0 {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("passbook: the response did not match the documented shape: %w", err)
	}
	return nil
}

// download makes the call and returns the response; the caller closes its body.
func (c *core) download(ctx context.Context, cl call, opts []RequestOption) (*http.Response, error) {
	return c.send(ctx, cl, opts)
}
