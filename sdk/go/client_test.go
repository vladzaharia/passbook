package passbook

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type fake struct {
	srv    *httptest.Server
	calls  atomic.Int32
	sleeps []time.Duration
}

// newFake serves handler and returns a client that records its backoff waits instead of sleeping.
func newFake(t *testing.T, handler func(n int, w http.ResponseWriter, r *http.Request), opts ...Option) (*Client, *fake) {
	t.Helper()
	f := &fake{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler(int(f.calls.Add(1)), w, r)
	}))
	t.Cleanup(f.srv.Close)
	record := func(c *core) {
		c.sleep = func(_ context.Context, d time.Duration) error {
			f.sleeps = append(f.sleeps, d)
			return nil
		}
	}
	c, err := NewClient("pb_test_key", append([]Option{WithBaseURL(f.srv.URL), record}, opts...)...)
	if err != nil {
		t.Fatal(err)
	}
	return c, f
}

func problemJSON(w http.ResponseWriter, status int, code string, extra string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, `{"title":"t","status":%d,"code":%q,"detail":"d"%s}`, status, code, extra)
}

const passJSON = `{"id":"p1","templateId":"t1"}`

func TestNewClientNeedsAKeyAndReadsTheMode(t *testing.T) {
	if _, err := NewClient(" "); err == nil {
		t.Error("an empty key was accepted")
	}
	for key, want := range map[string]string{"pb_test_x": "test", "pb_live_x": "live", "other": ""} {
		c, _ := NewClient(key)
		if c.Mode != want {
			t.Errorf("Mode for %s = %q, want %q", key, c.Mode, want)
		}
	}
}

func TestCreateReusesOneIdempotencyKeyAcrossRetries(t *testing.T) {
	var keys []string
	c, f := newFake(t, func(n int, w http.ResponseWriter, r *http.Request) {
		keys = append(keys, r.Header.Get("Idempotency-Key"))
		if n < 3 {
			problemJSON(w, 503, "UNAVAILABLE", "")
			return
		}
		w.WriteHeader(201)
		_, _ = io.WriteString(w, passJSON)
	})
	out, err := c.Passes.Create(context.Background(), &PassesCreateBody{TemplateID: "t1", Input: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	if out.ID != "p1" || len(keys) != 3 || keys[0] == "" || keys[0] != keys[1] || keys[1] != keys[2] {
		t.Errorf("id %q, keys %v", out.ID, keys)
	}
	if len(f.sleeps) != 2 {
		t.Errorf("slept %d times, want 2", len(f.sleeps))
	}
}

func TestACallerKeyWins(t *testing.T) {
	var got string
	c, _ := newFake(t, func(_ int, w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Idempotency-Key")
		w.WriteHeader(201)
		_, _ = io.WriteString(w, passJSON)
	})
	_, err := c.Passes.Create(context.Background(), &PassesCreateBody{TemplateID: "t1"}, WithIdempotencyKey("booking-9"))
	if err != nil || got != "booking-9" {
		t.Errorf("err %v, key %q", err, got)
	}
}

func TestAWriteWithoutAKeyIsNotRepeatedAfterA5xx(t *testing.T) {
	c, f := newFake(t, func(_ int, w http.ResponseWriter, _ *http.Request) { problemJSON(w, 500, "INTERNAL", "") })
	_, err := c.Passes.BulkReissue(context.Background(), &PassesBulkReissueBody{})
	var apiErr *APIError
	if !errors.As(err, &apiErr) || f.calls.Load() != 1 {
		t.Errorf("err %v after %d calls", err, f.calls.Load())
	}
}

func TestReadsRetryAfterA5xxAndANetworkError(t *testing.T) {
	c, f := newFake(t, func(n int, w http.ResponseWriter, r *http.Request) {
		switch n {
		case 1:
			hj, _ := w.(http.Hijacker)
			conn, _, _ := hj.Hijack()
			conn.Close()
		case 2:
			problemJSON(w, 502, "BAD_GATEWAY", "")
		default:
			_, _ = io.WriteString(w, passJSON)
		}
	})
	out, err := c.Passes.Retrieve(context.Background(), "p1")
	if err != nil || out.ID != "p1" || f.calls.Load() != 3 {
		t.Errorf("err %v, calls %d", err, f.calls.Load())
	}
}

func TestA429WaitsOutRetryAfter(t *testing.T) {
	c, f := newFake(t, func(n int, w http.ResponseWriter, r *http.Request) {
		if n == 1 {
			w.Header().Set("Retry-After", "3")
			problemJSON(w, 429, "RATE_LIMITED", "")
			return
		}
		_, _ = io.WriteString(w, passJSON)
	})
	if _, err := c.Passes.Void(context.Background(), "p1"); err != nil {
		t.Fatal(err)
	}
	if len(f.sleeps) != 1 || f.sleeps[0] != 3*time.Second {
		t.Errorf("sleeps %v", f.sleeps)
	}
}

func TestARetryAfterOverAMinuteIsReturned(t *testing.T) {
	c, f := newFake(t, func(_ int, w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "600")
		problemJSON(w, 429, "RATE_LIMITED", "")
	})
	_, err := c.Passes.Retrieve(context.Background(), "p1")
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatal(err)
	}
	if d, ok := apiErr.RetryAfter(); !ok || d != 600*time.Second || len(f.sleeps) != 0 {
		t.Errorf("retry after %v %v, sleeps %v", d, ok, f.sleeps)
	}
}

func TestRetriesStopAtMaxRetries(t *testing.T) {
	c, f := newFake(t, func(_ int, w http.ResponseWriter, _ *http.Request) { problemJSON(w, 503, "UNAVAILABLE", "") }, WithMaxRetries(1))
	if _, err := c.Passes.Retrieve(context.Background(), "p1"); err == nil || f.calls.Load() != 2 {
		t.Errorf("err %v, calls %d", err, f.calls.Load())
	}
}

func TestANetworkFailureIsAConnectionError(t *testing.T) {
	c, _ := NewClient("pb_test_key", WithBaseURL("http://127.0.0.1:1"), WithMaxRetries(0))
	_, err := c.Passes.Retrieve(context.Background(), "p1")
	var conn *ConnectionError
	if !errors.As(err, &conn) {
		t.Errorf("err %v", err)
	}
}

func TestErrorsCarryTheCode(t *testing.T) {
	c, _ := newFake(t, func(_ int, w http.ResponseWriter, _ *http.Request) {
		problemJSON(w, 422, "VALIDATION", `,"requestId":"req_1","issues":[{"path":"input.name","message":"Required"}]`)
	})
	_, err := c.Passes.Create(context.Background(), &PassesCreateBody{})
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatal(err)
	}
	if apiErr.Status != 422 || apiErr.Code != "VALIDATION" || apiErr.RequestID != "req_1" || apiErr.Issues[0].Path != "input.name" {
		t.Errorf("%+v", apiErr)
	}
	if apiErr.DocsURL() != "https://passbook.mobile/developers/errors/validation" && !strings.HasPrefix(apiErr.DocsURL(), "https://") {
		t.Errorf("docs url %q", apiErr.DocsURL())
	}
}

func TestAnErrorWithoutAProblemBodyStillHasACode(t *testing.T) {
	c, _ := newFake(t, func(_ int, w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(500)
		_, _ = io.WriteString(w, "boom")
	})
	_, err := c.Passes.BulkReissue(context.Background(), &PassesBulkReissueBody{})
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Code != "HTTP_ERROR" || apiErr.Detail != "boom" {
		t.Errorf("%v", err)
	}
}

func TestPathParametersAreEscaped(t *testing.T) {
	var raw string
	c, _ := newFake(t, func(_ int, w http.ResponseWriter, r *http.Request) {
		raw = r.URL.EscapedPath()
		_, _ = io.WriteString(w, passJSON)
	})
	if _, err := c.Passes.Retrieve(context.Background(), "a/b c"); err != nil || raw != "/api/v1/passes/a%2Fb%20c" {
		t.Errorf("err %v, path %q", err, raw)
	}
}

func TestQueryStructsBecomeParametersAndSkipNil(t *testing.T) {
	limit := int64(25)
	got := queryValues(&PassesListQuery{Limit: &limit})
	if got.Get("limit") != "25" || len(got) != 1 {
		t.Errorf("%v", got)
	}
	if len(queryValues(nil)) != 0 {
		t.Error("nil query")
	}
}

func TestListsWalkEveryPage(t *testing.T) {
	var cursors []string
	c, _ := newFake(t, func(_ int, w http.ResponseWriter, r *http.Request) {
		cursor := r.URL.Query().Get("cursor")
		cursors = append(cursors, cursor)
		next := map[string]string{"": "c1", "c1": "c2"}[cursor]
		nc := "null"
		if next != "" {
			nc = `"` + next + `"`
		}
		_, _ = io.WriteString(w, `{"items":[{"id":"`+"k"+cursor+`","orgId":"o","name":"n","prefix":"p","scopes":[],"createdBy":"u","createdAt":0,"lastUsedAt":null,"expiresAt":null,"revokedAt":null}],"nextCursor":`+nc+`}`)
	})
	pager := c.APIKeys.List(context.Background(), nil)
	var ids []string
	for pager.Next(context.Background()) {
		ids = append(ids, pager.Item().ID)
	}
	if pager.Err() != nil || strings.Join(ids, ",") != "k,kc1,kc2" || strings.Join(cursors, ",") != ",c1,c2" {
		t.Errorf("ids %v, cursors %v, err %v", ids, cursors, pager.Err())
	}
}

func TestAFeedStopsOnHasMoreFalse(t *testing.T) {
	c, f := newFake(t, func(_ int, w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"items":[],"nextCursor":"same","hasMore":false}`)
	})
	items, err := c.Events.List(context.Background(), nil).All(context.Background())
	if err != nil || len(items) != 0 || f.calls.Load() != 1 {
		t.Errorf("items %v err %v calls %d", items, err, f.calls.Load())
	}
}

func TestAListErrorEndsTheWalk(t *testing.T) {
	c, _ := newFake(t, func(_ int, w http.ResponseWriter, _ *http.Request) { problemJSON(w, 401, "UNAUTHENTICATED", "") })
	pager := c.APIKeys.List(context.Background(), nil)
	var apiErr *APIError
	if pager.Next(context.Background()) || !errors.As(pager.Err(), &apiErr) || apiErr.Status != 401 {
		t.Errorf("err %v", pager.Err())
	}
}

func TestADownloadReturnsTheResponse(t *testing.T) {
	c, _ := newFake(t, func(_ int, w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "a,b\n") })
	res, err := c.PassImports.DownloadResults(context.Background(), "i1")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if b, _ := io.ReadAll(res.Body); string(b) != "a,b\n" {
		t.Errorf("%q", b)
	}
}

func TestRetryAfterReadsSecondsAndDates(t *testing.T) {
	now := time.Date(2015, 10, 21, 7, 28, 0, 0, time.UTC)
	for header, want := range map[string]time.Duration{"2": 2 * time.Second, "Wed, 21 Oct 2015 07:28:10 GMT": 10 * time.Second, "Wed, 21 Oct 2015 07:20:00 GMT": 0} {
		if got, ok := retryAfter(header, now); !ok || got != want {
			t.Errorf("%q: %v %v, want %v", header, got, ok, want)
		}
	}
	for _, header := range []string{"inf", "+Inf", "1e300", "1e999", "61"} {
		if got, ok := retryAfter(header, now); !ok || got <= maxRetryAfter {
			t.Errorf("%q: %v %v, want over the limit", header, got, ok)
		}
	}
	if got, ok := retryAfter("nan", now); !ok || got != 0 {
		t.Errorf("nan: %v %v", got, ok)
	}
	for _, header := range []string{"", "soon"} {
		if _, ok := retryAfter(header, now); ok {
			t.Errorf("%q was read", header)
		}
	}
}

func TestBackoffGrowsAndIsCapped(t *testing.T) {
	if backoff(0, 500*time.Millisecond, 1) != 500*time.Millisecond || backoff(1, 500*time.Millisecond, 1) != time.Second {
		t.Error("growth")
	}
	if backoff(20, 500*time.Millisecond, 0) != 4*time.Second {
		t.Error("cap")
	}
}

func TestModeReadsEveryKeyLabel(t *testing.T) {
	for _, p := range []string{"pb", "pbp", "pbo"} {
		c, _ := NewClient(p + "_test_x")
		if c.Mode != "test" {
			t.Fatalf("%s_test_: mode %q", p, c.Mode)
		}
		c, _ = NewClient(p + "_live_x")
		if c.Mode != "live" {
			t.Fatalf("%s_live_: mode %q", p, c.Mode)
		}
	}
}

func TestCallsSendTheUserAgentAndAPIVersion(t *testing.T) {
	var agent, version []string
	pb, _ := newFake(t, func(n int, w http.ResponseWriter, r *http.Request) {
		agent = append(agent, r.Header.Get("User-Agent"))
		version = append(version, r.Header.Get("PassBook-Version"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{}"))
	})
	_, _ = pb.Passes.Retrieve(context.Background(), "p1")
	if agent[0] != "passbook-sdk-go/"+Version || version[0] != apiVersion {
		t.Fatalf("got %q %q", agent[0], version[0])
	}
	pb2, _ := newFake(t, func(n int, w http.ResponseWriter, r *http.Request) {
		version = append(version, r.Header.Get("PassBook-Version"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{}"))
	}, WithAPIVersion("2026-01-01"))
	_, _ = pb2.Passes.Retrieve(context.Background(), "p1")
	if version[1] != "2026-01-01" {
		t.Fatalf("got %q", version[1])
	}
}

func TestPerCallHeadersReplaceTheDefaultsInAnyCase(t *testing.T) {
	var got http.Header
	pb, _ := newFake(t, func(n int, w http.ResponseWriter, r *http.Request) {
		got = r.Header
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{}"))
	})
	_, _ = pb.Passes.Retrieve(context.Background(), "p1", WithHeader("passbook-version", "2026-01-01"), WithHeader("USER-AGENT", "call/2"))
	if v := got.Values("PassBook-Version"); len(v) != 1 || v[0] != "2026-01-01" {
		t.Fatalf("version %q", v)
	}
	if v := got.Values("User-Agent"); len(v) != 1 || v[0] != "call/2" {
		t.Fatalf("agent %q", v)
	}
}
