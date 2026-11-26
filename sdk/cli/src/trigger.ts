import { parseArgs } from 'node:util';
import type { Api } from './api.ts';

export const TRIGGER_EVENTS = [
  'installed',
  'uninstalled',
  'scanned',
  'scan_refused',
  'push_failed',
  'updated_on_device',
  'email_failed',
] as const;

/** `trigger <event>`: sends a real Test event for a pass and prints the ids that tie it to its webhooks. */
export async function triggerCommand(
  api: Api,
  args: string[],
  out: (line: string) => void,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { pass: { type: 'string' }, device: { type: 'string' } },
    allowPositionals: true,
  });
  const [event] = positionals;
  if (!event || !(TRIGGER_EVENTS as readonly string[]).includes(event))
    throw new Error(`trigger needs an event: ${TRIGGER_EVENTS.join(', ')}.`);
  // Without --pass, the newest pass the Test key can see: the one Quickstart made.
  const passId = values.pass ?? (await api.passes.list({ limit: 1 })).items[0]?.id;
  if (!passId) throw new Error('No Test pass yet. Create one, or pass --pass <passId>.');
  const body = { event, ...(values.device ? { deviceId: values.device } : {}) };
  out(JSON.stringify(await api.passes.simulate(passId, body), null, 2));
}
