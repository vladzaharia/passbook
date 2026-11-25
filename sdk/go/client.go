// Package passbook is the Go client for the PassBook API.
//
//	pb, err := passbook.NewClient(os.Getenv("PASSBOOK_KEY"))
//	pass, err := pb.Passes.Create(ctx, &passbook.PassesCreateBody{TemplateID: id, Input: map[string]any{"name": "Ada"}})
//
// A pbp_test_ key works in test mode: sandboxes never issue real passes.
package passbook

import (
	"errors"
	"net/http"
	"strings"
	"time"
)

// Client is the API client. Every resource is a field, named as in the API reference.
type Client struct {
	Resources
	// Mode is "live" or "test" from the key's prefix, and "" for a key that does not follow pb[p|o]_<mode>_.
	Mode string
}

// Option configures NewClient.
type Option func(*core)

// WithBaseURL replaces https://passbook.mobile.
func WithBaseURL(url string) Option { return func(c *core) { c.baseURL = strings.TrimRight(url, "/") } }

// WithHTTPClient replaces http.DefaultClient, for a proxy or a test double.
func WithHTTPClient(h *http.Client) Option { return func(c *core) { c.http = h } }

// WithMaxRetries sets the retries after the first attempt on 429, 5xx and network errors. Default 2.
func WithMaxRetries(n int) Option { return func(c *core) { c.maxRetries = n } }

// WithTimeout sets the time allowed per attempt. Default 60 seconds.
func WithTimeout(d time.Duration) Option { return func(c *core) { c.timeout = d } }

// WithRetryDelay sets the first backoff step. Default 500 ms.
func WithRetryDelay(d time.Duration) Option { return func(c *core) { c.retryDelay = d } }

// WithAPIVersion sets PassBook-Version. Default: the newest version this SDK was generated against.
func WithAPIVersion(v string) Option { return func(c *core) { c.apiVersion = v } }

// NewClient returns a client for the key.
func NewClient(apiKey string, opts ...Option) (*Client, error) {
	if strings.TrimSpace(apiKey) == "" {
		return nil, errors.New("passbook: apiKey is required: pass a pbp_live_ or pbp_test_ key")
	}
	c := &core{
		apiKey:     apiKey,
		baseURL:    "https://passbook.mobile",
		http:       http.DefaultClient,
		maxRetries: 2,
		timeout:    60 * time.Second,
		retryDelay: 500 * time.Millisecond,
		apiVersion: apiVersion,
		sleep:      sleepContext,
	}
	for _, o := range opts {
		o(c)
	}
	mode := ""
	for _, m := range []string{"live", "test"} {
		for _, p := range []string{"pb", "pbp", "pbo"} {
			if strings.HasPrefix(apiKey, p+"_"+m+"_") {
				mode = m
			}
		}
	}
	return &Client{Resources: newResources(c), Mode: mode}, nil
}
