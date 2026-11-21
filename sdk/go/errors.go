package passbook

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const errorsPage = "https://passbook.mobile/developers/errors/"

// Issue is one invalid field in a validation error.
type Issue struct {
	Path    string `json:"path"`
	Message string `json:"message"`
	Code    string `json:"code,omitempty"`
}

// APIError is a non-2xx answer. Branch on Code, which is stable, or on Status.
//
//	var apiErr *passbook.APIError
//	if errors.As(err, &apiErr) && apiErr.Code == "PASS_NOT_FOUND" { ... }
type APIError struct {
	Status    int
	Code      string
	Title     string
	Detail    string
	RequestID string
	Issues    []Issue
	// Feature, Limit and Used are set by FEATURE_NOT_INCLUDED and FEATURE_LIMIT_REACHED.
	Feature string
	Limit   *int64
	Used    *int64
	// Type is the problem type: a URL, or a urn:wallet:problem: name on older deployments.
	Type   string
	Header http.Header
}

func (e *APIError) Error() string {
	return fmt.Sprintf("passbook: %s (%d %s)", e.Detail, e.Status, e.Code)
}

// DocsURL is the error's page in the docs.
func (e *APIError) DocsURL() string {
	if strings.HasPrefix(e.Type, "https://") {
		return e.Type
	}
	return errorsPage + strings.ToLower(strings.ReplaceAll(e.Code, "_", "-"))
}

// RetryAfter is the Retry-After header, when it is a number of seconds.
func (e *APIError) RetryAfter() (time.Duration, bool) {
	s, err := strconv.ParseFloat(e.Header.Get("Retry-After"), 64)
	if err != nil {
		return 0, false
	}
	return time.Duration(s * float64(time.Second)), true
}

// ConnectionError means the request never produced a response: a network failure or a timeout.
type ConnectionError struct{ Err error }

func (e *ConnectionError) Error() string {
	return "passbook: could not reach PassBook: " + e.Err.Error()
}
func (e *ConnectionError) Unwrap() error { return e.Err }

type problem struct {
	Type      string  `json:"type"`
	Title     string  `json:"title"`
	Code      string  `json:"code"`
	Detail    string  `json:"detail"`
	RequestID string  `json:"requestId"`
	Issues    []Issue `json:"issues"`
	Feature   string  `json:"feature"`
	Limit     *int64  `json:"limit"`
	Used      *int64  `json:"used"`
}

func apiErrorFrom(status int, body []byte, header http.Header) *APIError {
	var p problem
	if err := json.Unmarshal(body, &p); err != nil {
		p = problem{Detail: strings.TrimSpace(string(body))}
		if len(p.Detail) > 200 {
			p.Detail = p.Detail[:200]
		}
	}
	e := &APIError{
		Status: status, Code: p.Code, Title: p.Title, Detail: p.Detail, RequestID: p.RequestID,
		Issues: p.Issues, Feature: p.Feature, Limit: p.Limit, Used: p.Used, Type: p.Type, Header: header,
	}
	if e.Code == "" {
		e.Code = "HTTP_ERROR"
	}
	if e.Detail == "" {
		e.Detail = e.Title
	}
	if e.Detail == "" {
		e.Detail = http.StatusText(status)
	}
	if e.Type == "" {
		e.Type = "urn:wallet:problem:" + strings.ToLower(strings.ReplaceAll(e.Code, "_", "-"))
	}
	return e
}
