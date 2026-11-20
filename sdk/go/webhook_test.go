package passbook

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"testing"
	"time"
)

type vector struct {
	ID      string            `json:"id"`
	Body    string            `json:"body"`
	SDK     string            `json:"sdk"`
	Secrets []string          `json:"secrets"`
	Headers map[string]string `json:"headers"`
	Now     int64             `json:"now"`
}

func vectors(t *testing.T) []vector {
	t.Helper()
	data, err := os.ReadFile("../../docs/api/webhook-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Vectors []vector `json:"vectors"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	return file.Vectors
}

func header(v vector) http.Header {
	h := http.Header{}
	for k, val := range v.Headers {
		h.Set(k, val)
	}
	return h
}

// The golden vectors every receiver is checked against; sdk is what VerifyWebhook reports.
func TestWebhookVectors(t *testing.T) {
	for _, v := range vectors(t) {
		t.Run(v.ID, func(t *testing.T) {
			event, err := VerifyWebhook([]byte(v.Body), header(v), v.Secrets[0], WithNow(time.Unix(v.Now, 0)))
			if v.SDK == "ok" {
				if err != nil {
					t.Fatal(err)
				}
				var want struct{ ID string }
				_ = json.Unmarshal([]byte(v.Body), &want)
				if event.ID != want.ID {
					t.Errorf("id %q", event.ID)
				}
				return
			}
			var sig *WebhookSignatureError
			if !errors.As(err, &sig) || sig.Reason != v.SDK {
				t.Errorf("err %v, want reason %s", err, v.SDK)
			}
		})
	}
}

func TestAnyOfTheSecretsMayMatchAndTheEventDecodes(t *testing.T) {
	v := vectors(t)[0]
	event, err := VerifyWebhook([]byte(v.Body), header(v), "whsec_old", WithSecrets(v.Secrets[0]), WithNow(time.Unix(v.Now, 0)))
	if err != nil {
		t.Fatal(err)
	}
	var typed PassUpdatedEvent
	if err := event.Decode(&typed); err != nil || event.Type != "pass.updated" || typed.Type != "pass.updated" {
		t.Errorf("err %v, type %q", err, event.Type)
	}
}

func TestTheToleranceIsConfigurable(t *testing.T) {
	v := vectors(t)[0]
	_, err := VerifyWebhook([]byte(v.Body), header(v), v.Secrets[0], WithNow(time.Unix(v.Now+3600, 0)), WithTolerance(2*time.Hour))
	if err != nil {
		t.Error(err)
	}
}
