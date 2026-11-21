package passbook

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// opCase is one row of ops_gen_test.go: a call made from the contract, the request the server should see
// and the response it sends.
type opCase struct {
	name       string
	method     string
	path       string
	idempotent bool
	body       string
	response   string
	call       func(ctx context.Context, c *Client, body []byte) (any, error)
}

func downloaded(res *http.Response, err error) (any, error) {
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	return string(b), err
}

// missing lists what is in want but not in got: every field of the sample must survive a round trip.
func missing(want, got any, at string) []string {
	switch w := want.(type) {
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			return []string{at + ": want an object"}
		}
		var out []string
		for k, v := range w {
			if _, has := g[k]; !has {
				out = append(out, at+"."+k+": missing")
				continue
			}
			out = append(out, missing(v, g[k], at+"."+k)...)
		}
		return out
	case []any:
		g, ok := got.([]any)
		if !ok || len(g) != len(w) {
			return []string{at + ": want an array of the same length"}
		}
		var out []string
		for i := range w {
			out = append(out, missing(w[i], g[i], at+"[]")...)
		}
		return out
	default:
		if want != got {
			return []string{at + ": value differs"}
		}
		return nil
	}
}

func decode(t *testing.T, text string) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(text), &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestGeneratedOps(t *testing.T) {
	for _, op := range generatedOps {
		t.Run(op.name, func(t *testing.T) {
			var gotBody []byte
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotBody, _ = io.ReadAll(r.Body)
				if r.Method != op.method || r.URL.Path != op.path {
					t.Errorf("sent %s %s, want %s %s", r.Method, r.URL.Path, op.method, op.path)
				}
				if r.Header.Get("Authorization") != "Bearer pb_test_key" {
					t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
				}
				if (r.Header.Get("Idempotency-Key") != "") != op.idempotent {
					t.Errorf("Idempotency-Key = %q, want one: %v", r.Header.Get("Idempotency-Key"), op.idempotent)
				}
				if op.response == "" {
					w.WriteHeader(http.StatusNoContent)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(op.response))
			}))
			defer srv.Close()
			c, err := NewClient("pb_test_key", WithBaseURL(srv.URL), WithMaxRetries(0))
			if err != nil {
				t.Fatal(err)
			}

			got, err := op.call(context.Background(), c, []byte(op.body))
			if err != nil {
				t.Fatal(err)
			}

			if strings.HasPrefix(op.body, "{") || strings.HasPrefix(op.body, "[") {
				if m := missing(decode(t, op.body), decode(t, string(gotBody)), "body"); len(m) > 0 {
					t.Errorf("the request body lost fields: %v", m)
				}
			}
			if got != nil && strings.HasPrefix(op.response, "{") {
				out, _ := json.Marshal(got)
				want := decode(t, op.response).(map[string]any)
				// A list returns its items alone.
				if items, ok := want["items"]; ok && strings.HasPrefix(string(out), "[") {
					want = map[string]any{"items": items}
					out, _ = json.Marshal(map[string]any{"items": got})
				}
				if m := missing(want, decode(t, string(out)), "result"); len(m) > 0 {
					t.Errorf("the result lost fields: %v", m)
				}
			}
		})
	}
}
