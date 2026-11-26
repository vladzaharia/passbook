import type { WebhookCaptureDto } from '../../../shared/contracts/webhook-captures.ts';

const shellQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/** The capture as a curl command to a receiver of yours: the same headers and bytes, signature included. */
export function curlOf(c: WebhookCaptureDto, target = 'http://localhost:3000/hooks'): string {
  const headers = Object.entries(c.headers)
    .map(([k, v]) => `-H ${shellQuote(`${k}: ${v}`)}`)
    .join(' \\\n  ');
  return `curl -X POST ${shellQuote(target)} \\\n  ${headers} \\\n  --data-raw ${shellQuote(c.body)}`;
}
