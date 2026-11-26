import { SDK_STATUS } from '../../../shared/developers-sdk.ts';
import type { Lang } from '../../developers/model/highlight.ts';

export interface VerifySample {
  id: 'ts' | 'py' | 'go' | 'node' | 'openssl';
  label: string;
  lang: Lang;
  code: string;
}

/**
 * Verification in five forms. Every one reads the raw body and checks `HMAC-SHA256(<timestamp>.<body>)`
 * against `v1=<hex>`; snippets.test.ts runs the ones it can against docs/api/webhook-vectors.json.
 */
const ALL_VERIFY_SAMPLES: VerifySample[] = [
  {
    id: 'ts',
    label: 'TypeScript',
    lang: 'ts',
    code: `import { verifyWebhook } from '@passbook/sdk';

const raw = await req.text(); // the raw body, not req.json()
const event = await verifyWebhook(raw, req.headers, $PASSBOOK_WEBHOOK_SECRET);
if (await seen(event.id)) return new Response('ok'); // dedupe on id`,
  },
  {
    id: 'py',
    label: 'Python',
    lang: 'py',
    code: `import hashlib
import hmac
import time

def verify(raw: bytes, headers: dict, secret: str) -> bool:
    ts = headers["x-passbook-timestamp"]
    if not ts.isdigit() or abs(time.time() - int(ts)) > 300:
        return False
    mac = hmac.new(secret.encode(), ts.encode() + b"." + raw, hashlib.sha256).hexdigest()
    sigs = [s.strip() for s in headers["x-passbook-signature"].split(",")]
    return any(hmac.compare_digest(f"v1={mac}", s) for s in sigs)`,
  },
  {
    id: 'go',
    label: 'Go',
    lang: 'go',
    code: `func verify(raw []byte, ts, sigHeader, secret string) bool {
	t, err := strconv.ParseInt(ts, 10, 64)
	if err != nil || math.Abs(float64(time.Now().Unix()-t)) > 300 {
		return false
	}
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(ts + "."))
	h.Write(raw)
	want := "v1=" + hex.EncodeToString(h.Sum(nil))
	for _, s := range strings.Split(sigHeader, ",") {
		if hmac.Equal([]byte(strings.TrimSpace(s)), []byte(want)) {
			return true
		}
	}
	return false
}`,
  },
  {
    id: 'node',
    label: 'Node, no SDK',
    lang: 'ts',
    code: `import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(raw, headers, secret, now = Date.now() / 1000) {
  const ts = headers['x-passbook-timestamp'];
  if (!/^\\d{9,12}$/.test(ts) || Math.abs(now - Number(ts)) > 300) return false;
  const mac = createHmac('sha256', secret).update(\`\${ts}.\${raw}\`).digest('hex');
  const want = Buffer.from(\`v1=\${mac}\`);
  return String(headers['x-passbook-signature']).split(',').some((s) => {
    const got = Buffer.from(s.trim());
    return got.length === want.length && timingSafeEqual(got, want);
  });
}`,
  },
  {
    id: 'openssl',
    label: 'openssl',
    lang: 'curl',
    code: `# TS is x-passbook-timestamp; BODY is the raw request body
printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -r -hmac "$PASSBOOK_WEBHOOK_SECRET" | awk '{print "v1=" $1}'`,
  },
];

/** The form that imports the SDK waits for the SDK. */
export const VERIFY_SAMPLES = ALL_VERIFY_SAMPLES.filter(
  (s) => s.id !== 'ts' || SDK_STATUS.typescript,
);
