import { HTTPException } from 'hono/http-exception';
export function bad(message: string): never { throw new HTTPException(400, { message }); }
export function assert(condition: unknown, message: string): asserts condition { if (!condition) bad(message); }
export function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected a JSON object');
  return value as Record<string, unknown>;
}
export function text(value: unknown, name: string, max = 200): string {
  assert(typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value), `Invalid ${name}`);
  return value;
}
export function email(value: unknown): string {
  const v = text(value, 'email', 254);
  assert(/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v), 'Invalid email');
  return v;
}
export function randomToken(): string { return crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''); }
export async function equal(a: string, b: string): Promise<boolean> {
  const hash = (v: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  const [x,y] = await Promise.all([hash(a),hash(b)]);
  const aa=new Uint8Array(x), bb=new Uint8Array(y);
  let diff=0; for(let i=0;i<aa.length;i++) diff |= aa[i]^bb[i];
  return diff===0;
}
export function escapeHtml(v: string): string { return v.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!)); }
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return '['+v.map(canonical).join(',')+']';
  if(v && typeof v==='object') return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';
  return JSON.stringify(v);
}
export const mime = 'application/vnd.apple.pkpass';
export function baseURL(value: string): string {
  const url = new URL(value);
  if(url.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(url.hostname)) throw new Error('PUBLIC_BASE_URL must use HTTPS');
  if(url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('PUBLIC_BASE_URL must be an origin');
  return url.origin;
}
