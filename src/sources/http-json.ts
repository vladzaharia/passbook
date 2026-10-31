import type { Json, Personalization } from '../types.ts';
import type { SourceContext, UpdateSource } from './types.ts';

/** An adapter supplies its own authenticated request and mapping. Never accepts URLs from pass holders. */
export function httpJsonSource(config: {
  id: string;
  intervalSeconds: number;
  request(context: SourceContext): Request;
  map(data: Json, context: SourceContext): Partial<Personalization>;
}): UpdateSource {
  return { id:config.id, intervalSeconds:config.intervalSeconds, async refresh(context) {
    const request=config.request(context);
    if(new URL(request.url).protocol!=='https:') throw new Error('Update sources require HTTPS');
    // Workers supports manual/follow, not redirect:error. Reject 3xx without following them.
    const response=await context.fetch(new Request(request,{redirect:'manual',signal:AbortSignal.timeout(15_000)}));
    if(!response.ok) throw new Error(`Upstream returned HTTP ${response.status}`);
    if(!response.headers.get('content-type')?.includes('application/json')) throw new Error('Upstream did not return JSON');
    // Bound streaming reads, including responses without Content-Length.
    const reader=response.body!.getReader(); let size=0; const chunks: Uint8Array[]=[];
    try { for(;;) { const {done,value}=await reader.read(); if(done) break; size+=value.length; if(size>256_000) throw new Error('Upstream response too large'); chunks.push(value); } }
    finally { await reader.cancel(); }
    const bytes=new Uint8Array(size); let offset=0; for(const c of chunks) { bytes.set(c,offset); offset+=c.length; }
    return config.map(JSON.parse(new TextDecoder().decode(bytes)),context);
  }};
}
