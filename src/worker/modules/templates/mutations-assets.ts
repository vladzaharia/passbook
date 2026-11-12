import type { ServiceContext } from '../../platform/service-context.ts';
import { assertTemplateAuthority, type TemplateAuthority } from './access.ts';

export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function deletePrefix(
  ctx: ServiceContext,
  prefix: string,
  authority: TemplateAuthority,
): Promise<void> {
  let cursor: string | undefined;
  do {
    await assertTemplateAuthority(ctx, authority);
    const page = await ctx.env.BUCKET.list({ prefix, cursor, limit: 500 });
    if (page.objects.length) {
      await assertTemplateAuthority(ctx, authority);
      await ctx.env.BUCKET.delete(page.objects.map((o) => o.key));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
