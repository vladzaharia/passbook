import type { WebhookCaptureDto } from '../../../shared/contracts/webhook-captures.ts';

/** "just now", "2 min", "3 h", "4 d". */
export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86_400)} d`;
}

const TRIGGER: Record<WebhookCaptureDto['trigger'], string> = {
  event: 'Event',
  test: 'Sent from this page',
  replay: 'Replayed',
};

/** The line under a capture's type: what it was, and which pass it was about when it has one. */
export function metaOf(c: WebhookCaptureDto): string {
  let pass = '';
  try {
    const event = JSON.parse(c.body) as {
      pass?: { externalId?: string | null; id?: string } | null;
    };
    pass = event.pass?.externalId ?? event.pass?.id ?? '';
  } catch {
    // A capture is always our own JSON; a broken one just has no pass to name.
  }
  return ['Capture', c.trigger === 'event' && pass ? pass : TRIGGER[c.trigger]].join(' · ');
}

const shellQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/** The capture as a curl command to a receiver of yours: the same headers and bytes, signature included. */
export function curlOf(c: WebhookCaptureDto, target = 'http://localhost:3000/hooks'): string {
  const headers = Object.entries(c.headers)
    .map(([k, v]) => `-H ${shellQuote(`${k}: ${v}`)}`)
    .join(' \\\n  ');
  return `curl -X POST ${shellQuote(target)} \\\n  ${headers} \\\n  --data-raw ${shellQuote(c.body)}`;
}

export function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

export const evtShort = (id: string) => (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);
