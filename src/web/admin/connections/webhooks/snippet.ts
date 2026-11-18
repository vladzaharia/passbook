/** The receiver's check, as in docs/api.md "Receive and verify": raw body, constant time, 5 minutes. */
export const VERIFY_SNIPPET = `import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(rawBody, headers, secret) {
  const ts = Number(headers['x-passbook-timestamp']);
  const header = headers['x-passbook-signature'];
  if (!Number.isFinite(ts) || !header || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const want = createHmac('sha256', secret).update(\`\${ts}.\${rawBody}\`).digest('hex');
  return header.split(',').some((part) => {
    const p = part.trim();
    if (!p.startsWith('v1=')) return false;
    const got = p.slice(3);
    return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
  });
}`;
