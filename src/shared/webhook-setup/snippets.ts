// PassBook's webhook scheme in code, shared by the admin wizard, the Workbench and the developer docs.
// One scheme for both directions: HMAC-SHA256 over "{timestamp}.{raw body}", sent as `v1=<hex>`,
// with a 5 minute window. Inbound accepts the x-passbook-* spelling, so the same code serves both.

export const SNIPPET_LANGS = ['node', 'python', 'go', 'curl'] as const;
export type SnippetLang = (typeof SNIPPET_LANGS)[number];

export const SNIPPET_LABEL: Record<SnippetLang, string> = {
  node: 'Node',
  python: 'Python',
  go: 'Go',
  curl: 'curl',
};

/** The languages a receiver is written in: curl only tests one (see `selfTestSnippet`). */
export const VERIFY_LANGS = ['node', 'python', 'go'] as const;
export type VerifyLang = (typeof VERIFY_LANGS)[number];

const NODE_VERIFY = `import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(rawBody, headers, secret) {
  const ts = headers['x-passbook-timestamp'];
  const header = headers['x-passbook-signature'];
  if (!/^\\d+$/.test(ts ?? '') || !header || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const want = createHmac('sha256', secret).update(\`\${ts}.\${rawBody}\`).digest('hex');
  return header.split(',').some((part) => {
    const p = part.trim();
    if (!p.startsWith('v1=')) return false;
    const got = p.slice(3);
    return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
  });
}`;

const PYTHON_VERIFY = `import hashlib
import hmac
import time


def verify(raw_body: bytes, headers: dict, secret: str) -> bool:
    ts = headers.get("x-passbook-timestamp", "")
    header = headers.get("x-passbook-signature", "")
    if not ts.isdigit() or not header or abs(time.time() - int(ts)) > 300:
        return False
    want = hmac.new(secret.encode(), ts.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    for part in header.split(","):
        part = part.strip()
        if part.startswith("v1=") and hmac.compare_digest(part[3:], want):
            return True
    return False`;

const GO_VERIFY = `package webhook

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"math"
	"strconv"
	"strings"
	"time"
)

// Verify checks x-passbook-timestamp and x-passbook-signature over the raw body.
func Verify(rawBody []byte, timestamp, signature, secret string) bool {
	sent, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || signature == "" || math.Abs(float64(time.Now().Unix()-sent)) > 300 {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp + "."))
	mac.Write(rawBody)
	want := mac.Sum(nil)
	for _, part := range strings.Split(signature, ",") {
		part = strings.TrimSpace(part)
		if !strings.HasPrefix(part, "v1=") {
			continue
		}
		if got, err := hex.DecodeString(part[3:]); err == nil && hmac.Equal(got, want) {
			return true
		}
	}
	return false
}`;

const VERIFY: Record<VerifyLang, string> = {
  node: NODE_VERIFY,
  python: PYTHON_VERIFY,
  go: GO_VERIFY,
};

/** The receiver's check: raw body, constant time, 5 minutes, any one live `v1=` value. */
export const verifySnippet = (lang: VerifyLang): string => VERIFY[lang];

/** A request a receiver should refuse: its signature is made up. A 401 means the check works. */
export function selfTestSnippet(url: string): string {
  return [
    `curl -i -X POST '${url}' \\`,
    "  -H 'content-type: application/json' \\",
    '  -H "x-passbook-timestamp: $(date +%s)" \\',
    "  -H 'x-passbook-signature: v1=0000000000000000000000000000000000000000000000000000000000000000' \\",
    '  -d \'{"id":"self-test"}\'',
  ].join('\n');
}

export interface SendOptions {
  url: string;
  /** Header names the connection reads; the defaults are PassBook's. */
  signatureHeader?: string;
  timestampHeader?: string;
  /** The JSON the sender posts. The default is the custom connection's shape. */
  body?: string;
}

/** What a custom connection reads by default: one record with its ref. */
export const SAMPLE_BODY =
  '{"id":"evt-1","records":[{"ref":"m-001","record":{"name":"Maya Chen"},"deleted":false}]}';

const quote = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/**
 * A signed request to a connection's URL, in each language. The secret is never inlined: it is read
 * from the PASSBOOK_SECRET environment variable.
 */
export function sendSnippet(lang: SnippetLang, options: SendOptions): string {
  const url = options.url;
  const sig = options.signatureHeader ?? 'x-passbook-signature';
  const ts = options.timestampHeader ?? 'x-passbook-timestamp';
  const body = options.body ?? SAMPLE_BODY;
  switch (lang) {
    case 'curl':
      return [
        `body='${body.replace(/'/g, "'\\''")}'`,
        'ts=$(date +%s)',
        'sig=$(printf "%s.%s" "$ts" "$body" | openssl dgst -sha256 -hmac "$PASSBOOK_SECRET" -hex | sed "s/^.* //")',
        `curl -X POST '${url}' \\`,
        "  -H 'content-type: application/json' \\",
        `  -H "${ts}: $ts" \\`,
        `  -H "${sig}: v1=$sig" \\`,
        '  -d "$body"',
      ].join('\n');
    case 'node':
      return `import { createHmac } from 'node:crypto';

const body = '${quote(body)}';
const ts = Math.floor(Date.now() / 1000);
const mac = createHmac('sha256', process.env.PASSBOOK_SECRET).update(\`\${ts}.\${body}\`).digest('hex');

const res = await fetch('${quote(url)}', {
  method: 'POST',
  headers: { 'content-type': 'application/json', '${ts}': String(ts), '${sig}': \`v1=\${mac}\` },
  body,
});
console.log(res.status, await res.text());`;
    case 'python':
      return `import hashlib
import hmac
import os
import time
import urllib.error
import urllib.request

body = b'${quote(body)}'
ts = str(int(time.time()))
mac = hmac.new(os.environ["PASSBOOK_SECRET"].encode(), ts.encode() + b"." + body, hashlib.sha256).hexdigest()

req = urllib.request.Request(
    "${url}",
    data=body,
    method="POST",
    headers={"content-type": "application/json", "${ts}": ts, "${sig}": "v1=" + mac},
)
try:
    with urllib.request.urlopen(req) as res:
        print(res.status, res.read().decode())
except urllib.error.HTTPError as err:
    print(err.code, err.read().decode())`;
    case 'go':
      return `package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"
)

func main() {
	body := []byte(\`${body}\`)
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, []byte(os.Getenv("PASSBOOK_SECRET")))
	mac.Write([]byte(ts + "."))
	mac.Write(body)

	req, _ := http.NewRequest("POST", "${url}", bytes.NewReader(body))
	req.Header.Set("content-type", "application/json")
	req.Header.Set("${ts}", ts)
	req.Header.Set("${sig}", "v1="+hex.EncodeToString(mac.Sum(nil)))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		panic(err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	fmt.Println(res.StatusCode, string(out))
}`;
  }
}
