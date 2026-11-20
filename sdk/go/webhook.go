package passbook

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Event is a verified webhook delivery. Raw is the body; decode it into the event's type, such as
// PassUpdatedEvent, chosen by Type.
type Event struct {
	ID         string          `json:"id"`
	Type       string          `json:"type"`
	APIVersion string          `json:"apiVersion"`
	CreatedAt  int64           `json:"createdAt"`
	OrgID      string          `json:"orgId"`
	Mode       string          `json:"mode"`
	Raw        json.RawMessage `json:"-"`
}

// Decode reads the event into v.
func (e *Event) Decode(v any) error { return json.Unmarshal(e.Raw, v) }

// WebhookSignatureError is a delivery that failed verification. Reason is one of missing_header,
// malformed, timestamp_out_of_range or mismatch.
type WebhookSignatureError struct {
	Reason  string
	Message string
}

func (e *WebhookSignatureError) Error() string { return "passbook: " + e.Message }

// VerifyOption changes VerifyWebhook.
type VerifyOption func(*verifyOptions)

type verifyOptions struct {
	tolerance time.Duration
	now       time.Time
	secrets   []string
}

// WithTolerance sets how far the signed timestamp may be from now, either way. Default 5 minutes.
func WithTolerance(d time.Duration) VerifyOption { return func(o *verifyOptions) { o.tolerance = d } }

// WithNow sets the clock, for tests.
func WithNow(t time.Time) VerifyOption { return func(o *verifyOptions) { o.now = t } }

// WithSecrets adds secrets that also verify, for a receiver that rotates its own.
func WithSecrets(secrets ...string) VerifyOption {
	return func(o *verifyOptions) { o.secrets = append(o.secrets, secrets...) }
}

var v1 = regexp.MustCompile(`^v1=([0-9a-f]{64})$`)
var timestampRe = regexp.MustCompile(`^\d{9,12}$`)

// VerifyWebhook checks a webhook delivery and returns the event. Pass the raw body exactly as received,
// before any JSON parsing. The signature is HMAC-SHA256 over "<timestamp>.<body>"; while a secret rotates
// the header lists one v1= value per live secret and any match passes.
func VerifyWebhook(payload []byte, header http.Header, secret string, opts ...VerifyOption) (*Event, error) {
	o := verifyOptions{tolerance: 5 * time.Minute, now: time.Now(), secrets: []string{secret}}
	for _, f := range opts {
		f(&o)
	}
	signature, timestamp := header.Get("X-Passbook-Signature"), header.Get("X-Passbook-Timestamp")
	if signature == "" || timestamp == "" {
		return nil, &WebhookSignatureError{"missing_header", "the x-passbook-signature and x-passbook-timestamp headers are required"}
	}
	var candidates []string
	for _, part := range strings.Split(signature, ",") {
		if m := v1.FindStringSubmatch(strings.TrimSpace(part)); m != nil {
			candidates = append(candidates, m[1])
		}
	}
	if !timestampRe.MatchString(timestamp) || len(candidates) == 0 {
		return nil, &WebhookSignatureError{"malformed", "the signature or timestamp header is malformed"}
	}
	seconds, _ := strconv.ParseInt(timestamp, 10, 64)
	skew := o.now.Sub(time.Unix(seconds, 0))
	if skew < 0 {
		skew = -skew
	}
	if skew > o.tolerance {
		return nil, &WebhookSignatureError{"timestamp_out_of_range", "the timestamp is outside the tolerance"}
	}
	message := append([]byte(timestamp+"."), payload...)
	matched := false
	for _, s := range o.secrets {
		mac := hmac.New(sha256.New, []byte(s))
		mac.Write(message)
		want := mac.Sum(nil)
		for _, c := range candidates {
			got, err := hex.DecodeString(c)
			if err == nil && hmac.Equal(want, got) {
				matched = true
			}
		}
	}
	if !matched {
		return nil, &WebhookSignatureError{"mismatch", "the signature does not match"}
	}
	e := &Event{Raw: json.RawMessage(payload)}
	if err := json.Unmarshal(payload, e); err != nil {
		return nil, &WebhookSignatureError{"malformed", "the body is not a JSON event"}
	}
	return e, nil
}
