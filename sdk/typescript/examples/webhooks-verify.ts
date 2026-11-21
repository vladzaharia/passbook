import { verifyWebhook } from '@passbook/sdk';

/** A fetch-style handler: Workers, Deno, Bun, or Node behind a Request adapter. */
export async function handle(request: Request): Promise<Response> {
  const body = await request.text();
  try {
    const event = await verifyWebhook(
      body,
      request.headers,
      process.env.PASSBOOK_WEBHOOK_SECRET ?? '',
    );
    if (event.type === 'pass.issued') console.log('issued', event.pass.id);
    return new Response('ok');
  } catch {
    return new Response('bad signature', { status: 400 });
  }
}
