const encoder = new TextEncoder();

/** HMAC-SHA256 over `<x-passbook-timestamp>.<raw body>`. While a secret rotates the header holds one `v1=` per secret. */
async function verify(body: string, headers: Headers, secret: string): Promise<boolean> {
  const timestamp = headers.get('x-passbook-timestamp') ?? '';
  if (!/^\d{9,12}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300)
    return false;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  for (const part of (headers.get('x-passbook-signature') ?? '').split(',')) {
    const hex = /^v1=([0-9a-f]{64})$/.exec(part.trim())?.[1];
    if (!hex) continue;
    const mac = Uint8Array.from(hex.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
    if (await crypto.subtle.verify('HMAC', key, mac, encoder.encode(`${timestamp}.${body}`)))
      return true;
  }
  return false;
}

/** A fetch-style handler: Workers, Deno, Bun, or Node behind a Request adapter. */
export async function handle(request: Request): Promise<Response> {
  // Verify the raw body. Parsing it first changes the bytes.
  const body = await request.text();
  if (!(await verify(body, request.headers, process.env.PASSBOOK_WEBHOOK_SECRET ?? '')))
    return new Response('bad signature', { status: 400 });
  const event = JSON.parse(body) as { id: string; type: string; pass?: { id: string } };
  if (event.type === 'pass.issued') console.log('issued', event.pass?.id);
  return new Response('ok');
}
